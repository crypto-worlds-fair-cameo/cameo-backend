import { Controller, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import type { SiwsSignInInput } from '../../resources/siws/siws';
import { AUTH_CHALLENGE_TTL_SECONDS } from '../../resources/challenge/challenge';
import {
  authCookies,
  readAuthCookie,
} from '../../resources/auth-cookie/auth-http';
import {
  CreateChallengeUseCase,
  type CreateChallengeResult,
} from './create-challenge.use-case';

class SiwsSignInInputResponse implements SiwsSignInInput {
  @ApiProperty({
    example: 'app.example.com',
    description: '요청 출처의 호스트. 포트를 포함합니다.',
  })
  domain!: string;

  @ApiProperty({ example: 'Sign in to Cameo.' })
  statement!: string;

  @ApiProperty({ format: 'uri', example: 'https://app.example.com/' })
  uri!: string;

  @ApiProperty({ enum: ['1'] })
  version!: '1';

  @ApiProperty({ enum: ['mainnet'] })
  chainId!: 'mainnet';

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  nonce!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: '발급 후 5분 뒤의 만료 시각.',
  })
  expirationTime!: string;

  @ApiProperty({ format: 'uuid', description: 'challengeId와 같은 값.' })
  requestId!: string;
}

class CreateChallengeResponse implements Pick<
  CreateChallengeResult,
  'challengeId' | 'signInInput'
> {
  @ApiProperty({ format: 'uuid' })
  challengeId!: string;

  @ApiProperty({ type: SiwsSignInInputResponse })
  signInInput!: SiwsSignInInputResponse;
}

@ApiTags('Auth')
@Controller('auth/challenges')
export class CreateChallengeController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly createChallenge: CreateChallengeUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 본문·쿼리를 업무 입력으로 사용하지 않고, 저장 성공 후에만 연결 쿠키를 발급한다. */
  @Post()
  @ApiHeader({
    name: 'Origin',
    required: true,
    description:
      '허용된 요청 출처. 브라우저가 자동 설정하며 입력값으로 덮어쓸 수 없습니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiOperation({
    summary: '로그인 챌린지 발급',
    description:
      '로그인 없이 호출합니다. 허용된 Origin이 필수이며 본문은 없습니다. signInInput을 지갑의 solana:signIn에 그대로 전달하세요. 챌린지는 5분 동안 한 번 사용할 수 있습니다.',
  })
  @ApiSuccessResponse(CreateChallengeResponse, {
    status: 201,
    description:
      '챌린지와 서명 입력을 반환하고 연결 쿠키를 300초로 설정합니다.',
  })
  @ApiErrorResponses([AuthErrorCodes.AuthOriginNotAllowed])
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateChallengeResponse> {
    const browserBinding = readAuthCookie(
      request.headers.cookie,
      this.cookies.bindingName,
    );
    const result = await this.createChallenge.execute(
      request.get('Origin'),
      browserBinding,
    );

    // 쿠키는 DB 커밋 뒤에 설정한다. 연결값 원문은 응답 JSON에 포함하지 않는다.
    response.cookie(this.cookies.bindingName, result.browserBinding, {
      ...this.cookies.options,
      maxAge: AUTH_CHALLENGE_TTL_SECONDS * 1000,
    });
    return {
      challengeId: result.challengeId,
      signInInput: result.signInInput,
    };
  }
}
