import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import {
  authCookies,
  readAuthCookie,
} from '../../resources/auth-cookie/auth-http';
import { LogoutUseCase } from './logout.use-case';

class LogoutResponse {
  @ApiProperty({ enum: [true] })
  loggedOut!: true;
}

@ApiTags('Auth')
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
  @ApiHeader({
    name: 'Origin',
    required: true,
    description:
      '허용된 요청 출처. 브라우저가 자동 설정하며 입력값으로 덮어쓸 수 없습니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiOperation({
    summary: '로그아웃',
    description:
      '허용된 Origin이 필수이며 본문은 없습니다. 제출한 세션을 폐기하고 세션·챌린지 연결 쿠키를 삭제합니다. 세션 쿠키가 없거나 만료됐어도 성공하며 다른 세션은 유지합니다.',
  })
  @ApiSuccessResponse(LogoutResponse)
  @ApiErrorResponses([AuthErrorCodes.AuthOriginNotAllowed])
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
