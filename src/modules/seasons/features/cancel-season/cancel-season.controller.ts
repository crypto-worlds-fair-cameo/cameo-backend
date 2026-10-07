import {
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { SeasonErrorCodes } from '../../resources/season/season.error-codes';
import {
  SeasonDetailResponse,
  toSeasonDetailResponse,
} from '../../resources/season/season-http';
import { CancelSeasonUseCase } from './cancel-season.use-case';

@ApiTags('Seasons')
@Controller('seasons/:id/cancel')
export class CancelSeasonController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly cancelSeason: CancelSeasonUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** UUID와 현재 세션만 업무 흐름에 전달하며 취소된 시즌의 전체 상태를 반환한다. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '예약 시즌 취소',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 개설자만 시작 전 예약 시즌을 취소할 수 있습니다. 같은 취소를 다시 요청하면 최초 취소 시각을 유지한 결과를 반환합니다. 진행 또는 종료된 시즌은 취소로 바꾸지 않습니다. 본문은 없습니다.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: '취소할 시즌과 캔버스의 공통 ID.',
  })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(SeasonDetailResponse, {
    description: '취소 상태와 최초 취소 시각을 포함한 시즌을 반환합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthOriginNotAllowed,
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonNotFound,
      SeasonErrorCodes.SeasonOwnerRequired,
      SeasonErrorCodes.SeasonStateConflict,
      SeasonErrorCodes.SeasonTemporarilyUnavailable,
    ],
    { rateLimited: false },
  )
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<SeasonDetailResponse> {
    const detail = await this.cancelSeason.execute(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      id,
    );
    return toSeasonDetailResponse(detail);
  }
}
