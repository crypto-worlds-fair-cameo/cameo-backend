import { Controller, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AllConfigType } from '../../../config/config.type';
import { AUTH_CHALLENGE_TTL_SECONDS } from '../challenge/challenge';
import { authCookies, readAuthCookie } from '../auth-http';
import {
  CreateChallengeUseCase,
  type CreateChallengeResult,
} from './create-challenge.use-case';

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
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Pick<CreateChallengeResult, 'challengeId' | 'signInInput'>> {
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
