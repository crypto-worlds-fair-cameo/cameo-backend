import { performance } from 'node:perf_hooks';
import { Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { BusinessError } from '../../../business-error';
import type { AllConfigType } from '../../../config/config.type';
import { authCookies, readAuthCookie } from '../auth-http';
import { MeUseCase } from './me.use-case';

@Controller('auth/me')
export class MeController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly me: MeUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 현재 세션만 조회하며 확정된 결과에 따라 같은 쿠키를 재발급하거나 삭제한다. */
  @Get()
  async getCurrentUser(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.me.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
    );

    // 업무 실패를 HTTP 오류로 전환하기 전에 같은 적용 범위의 세션 쿠키를 삭제한다.
    if (result.outcome !== 'authenticated') {
      response.cookie(this.cookies.sessionName, '', {
        ...this.cookies.options,
        maxAge: 0,
      });
      throw new BusinessError(
        result.outcome === 'invalid'
          ? {
              kind: 'unauthorized',
              code: 'AUTH_SESSION_INVALID',
              message: '로그인이 필요합니다.',
            }
          : {
              kind: 'forbidden',
              code: 'AUTH_USER_UNAVAILABLE',
              message: '이 계정으로 로그인할 수 없습니다.',
            },
      );
    }

    // DB에서 계산한 수명에서 커밋·응답 준비 시간을 빼며 연결 쿠키는 변경하지 않는다.
    response.cookie(this.cookies.sessionName, result.token, {
      ...this.cookies.options,
      maxAge:
        Math.max(
          0,
          Math.ceil((result.sessionExpiryDeadline - performance.now()) / 1000),
        ) * 1000,
    });
    return { user: result.user, session: result.session };
  }
}
