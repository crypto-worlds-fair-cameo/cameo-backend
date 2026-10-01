import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import {
  authCookies,
  readAuthCookie,
} from '../../resources/auth-cookie/auth-http';
import { LogoutUseCase } from './logout.use-case';

@Controller('auth/logout')
export class LogoutController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly logoutUseCase: LogoutUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 본문·쿼리를 사용하지 않고, 제출 세션 폐기 확정 후 인증 쿠키 두 개를 삭제한다. */
  @Post()
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Readonly<{ loggedOut: true }>> {
    const token = readAuthCookie(
      request.headers.cookie,
      this.cookies.sessionName,
    );
    await this.logoutUseCase.execute(request.get('Origin'), token);

    // 토큰 누락·형식 오류·미존재도 멱등 성공이므로 두 인증 쿠키를 항상 삭제한다.
    response.cookie(this.cookies.sessionName, '', {
      ...this.cookies.options,
      maxAge: 0,
    });
    response.cookie(this.cookies.bindingName, '', {
      ...this.cookies.options,
      maxAge: 0,
    });
    return { loggedOut: true };
  }
}
