import { Controller, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AllConfigType } from '../../../config/config.type';
import { AUTH_CHALLENGE_TTL_SECONDS } from '../challenge/challenge';
import {
  CreateChallengeUseCase,
  type CreateChallengeResult,
} from './create-challenge.use-case';

/** 중복된 같은 이름의 쿠키는 브라우저 연결값을 하나로 판단할 수 없으므로 사용하지 않는다. */
function readBindingCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  const prefix = `${cookieName}=`;
  const cookies = cookieHeader
    ?.split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix));
  return cookies?.length === 1 ? cookies[0].slice(prefix.length) : undefined;
}

@Controller('auth/challenges')
export class CreateChallengeController {
  private readonly secure: boolean;
  private readonly cookieName: string;

  constructor(
    private readonly createChallenge: CreateChallengeUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.secure =
      config.getOrThrow('app.nodeEnv', { infer: true }) === 'production';
    this.cookieName = this.secure
      ? '__Host-cameo_auth_binding'
      : 'cameo_auth_binding';
  }

  /** 본문·쿼리를 업무 입력으로 사용하지 않고, 저장 성공 후에만 연결 쿠키를 발급한다. */
  @Post()
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Pick<CreateChallengeResult, 'challengeId' | 'signInInput'>> {
    const browserBinding = readBindingCookie(
      request.headers.cookie,
      this.cookieName,
    );
    const result = await this.createChallenge.execute(
      request.get('Origin'),
      browserBinding,
    );

    // 쿠키는 DB 커밋 뒤에 설정한다. 연결값 원문은 응답 JSON에 포함하지 않는다.
    response.cookie(this.cookieName, result.browserBinding, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: AUTH_CHALLENGE_TTL_SECONDS * 1000,
    });
    return {
      challengeId: result.challengeId,
      signInInput: result.signInInput,
    };
  }
}
