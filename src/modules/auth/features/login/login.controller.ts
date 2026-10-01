import { isUtf8 } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, IsUUID, ValidateBy } from 'class-validator';
import type { Request, Response } from 'express';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import { AuthenticatedSessionResponse } from '../../resources/session/session-http';
import type { AllConfigType } from '../../../../config/config.type';
import {
  authCookies,
  readAuthCookie,
} from '../../resources/auth-cookie/auth-http';
import { decodeSolanaAddress } from '../../resources/siws/siws';
import { LoginUseCase } from './login.use-case';

/** 느슨한 디코더의 보정을 허용하지 않고, 필요한 패딩을 포함한 정규 Base64만 통과시킨다. */
function canonicalBase64(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): boolean {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return false;
  const bytes = Buffer.from(value, 'base64');
  return (
    bytes.length >= minBytes &&
    bytes.length <= maxBytes &&
    bytes.toString('base64') === value
  );
}

class LoginBody {
  @ApiProperty({ format: 'uuid', description: '챌린지 발급 응답의 UUID v4.' })
  @IsUUID('4')
  challengeId!: string;

  @ApiProperty({
    minLength: 32,
    maxLength: 44,
    pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
    description: '지갑이 반환한 Solana 주소. 디코딩 시 32바이트여야 합니다.',
    example: '6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L',
  })
  @IsString()
  @ValidateBy({
    name: 'solanaAddress',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && !!decodeSolanaAddress(value),
      defaultMessage: () => 'address must be a 32-byte Solana public key',
    },
  })
  address!: string;

  @ApiProperty({
    minLength: 4,
    maxLength: 5464,
    description:
      '지갑이 반환한 원본 UTF-8 메시지(1~4096바이트)의 표준 Base64. 필요한 = 패딩을 포함하며 메시지를 재구성하지 않습니다.',
  })
  @IsString()
  @ValidateBy({
    name: 'siwsMessage',
    validator: {
      validate: (value: unknown) =>
        canonicalBase64(value, 1, 4096) &&
        isUtf8(Buffer.from(value as string, 'base64')),
      defaultMessage: () =>
        'signedMessage must be canonical Base64 UTF-8 of 1..4096 bytes',
    },
  })
  signedMessage!: string;

  @ApiProperty({
    minLength: 88,
    maxLength: 88,
    description:
      '지갑이 반환한 Ed25519 서명(64바이트)의 표준 Base64. Base64url·공백·줄바꿈은 허용하지 않습니다.',
  })
  @IsString()
  @ValidateBy({
    name: 'ed25519Signature',
    validator: {
      validate: (value: unknown) => canonicalBase64(value, 64, 64),
      defaultMessage: () => 'signature must be canonical Base64 of 64 bytes',
    },
  })
  signature!: string;
}

@ApiTags('Auth')
@Controller('auth/login')
export class LoginController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly login: LoginUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 허용된 DTO 필드만 업무 입력으로 전달하고, 확인된 커밋 후 세션·연결 쿠키를 설정한다. */
  @Post()
  @HttpCode(200)
  @ApiHeader({
    name: 'Origin',
    required: true,
    description:
      '챌린지 발급과 동일한 허용 출처. 브라우저가 자동 설정하며 입력값으로 덮어쓸 수 없습니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiOperation({
    summary: '지갑 로그인',
    description:
      '챌린지 발급 출처와 동일한 허용 Origin과 연결 쿠키가 필요합니다. Content-Type은 application/json이며 charset은 utf-8만 허용합니다. 처음 로그인한 지갑은 자동 가입합니다. 챌린지는 한 번만 사용하며 재시도 시 새 챌린지와 서명을 받으세요.',
  })
  @ApiBody({ type: LoginBody, required: true })
  @ApiCookieAuth('challengeBinding')
  @ApiSuccessResponse(AuthenticatedSessionResponse, {
    description:
      '세션 쿠키를 발급하고 연결 쿠키를 삭제합니다. 제출된 기존 세션만 폐기합니다.',
  })
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthChallengeInvalid,
    AuthErrorCodes.AuthSignatureInvalid,
    AuthErrorCodes.AuthUserUnavailable,
  ])
  async create(
    @Body() body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedSessionResponse> {
    const result = await this.login.execute({
      challengeId: body.challengeId,
      address: body.address,
      signedMessage: Buffer.from(body.signedMessage, 'base64'),
      signature: Buffer.from(body.signature, 'base64'),
      origin: request.get('Origin'),
      browserBinding: readAuthCookie(
        request.headers.cookie,
        this.cookies.bindingName,
      ),
      previousToken: readAuthCookie(
        request.headers.cookie,
        this.cookies.sessionName,
      ),
    });
    if (result.outcome === 'unavailable') {
      response.cookie(this.cookies.bindingName, '', {
        ...this.cookies.options,
        maxAge: 0,
      });
      throw new BusinessError(ErrorCodes.AuthUserUnavailable);
    }
    // DB에서 측정한 남은 수명에서 커밋까지의 경과를 빼고 초 단위로 올림한다.
    response.cookie(this.cookies.sessionName, result.token, {
      ...this.cookies.options,
      maxAge:
        Math.max(
          0,
          Math.ceil((result.sessionExpiryDeadline - performance.now()) / 1000),
        ) * 1000,
    });
    response.cookie(this.cookies.bindingName, '', {
      ...this.cookies.options,
      maxAge: 0,
    });
    return { user: result.user, session: result.session };
  }
}
