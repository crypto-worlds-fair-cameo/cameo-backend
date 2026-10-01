import { performance } from 'node:perf_hooks';
import { Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { MeUseCase } from './me.use-case';

@ApiTags('Auth')
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
  @ApiOperation({
    summary: '현재 사용자 조회',
    description:
      '세션 쿠키가 필요하며 본문은 없습니다. 성공 시 미접속 만료를 현재부터 7일로 연장하고 같은 세션 쿠키를 갱신합니다. 최초 발급 후 30일의 절대 만료는 넘지 않습니다. 세션이 유효하지 않거나 계정을 사용할 수 없으면 세션 쿠키를 삭제합니다.',
  })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(AuthenticatedSessionResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
  ])
  async getCurrentUser(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedSessionResponse> {
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
          ? ErrorCodes.AuthSessionInvalid
          : ErrorCodes.AuthUserUnavailable,
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
