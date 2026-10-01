import { isUtf8 } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsUUID, ValidateBy } from 'class-validator';
import type { Request, Response } from 'express';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
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
  @IsUUID('4')
  challengeId!: string;

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
  async create(
    @Body() body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
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
