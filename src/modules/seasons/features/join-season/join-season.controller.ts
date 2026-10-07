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
import { JoinSeasonUseCase } from './join-season.use-case';

@ApiTags('Seasons')
@Controller('seasons/:id/join')
export class JoinSeasonController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly joinSeason: JoinSeasonUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** UUID와 현재 세션을 참가 흐름에 전달하고 최신 시즌 상세를 반환한다. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '진행 중 시즌 참가',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 진행 중인 시즌에 빈자리가 있으면 참가자를 등록합니다. 이미 참가한 사용자는 시즌 상태나 정원과 관계없이 참가 기록을 추가하지 않고 최신 상세를 받습니다. 취소된 시즌은 개설자에게만 기존 자동 참가 기록을 포함한 상세를 반환합니다. 본문은 없습니다.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: '참가할 시즌과 캔버스의 공통 ID.',
  })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(SeasonDetailResponse, {
    description: '참가 여부와 최신 참가 인원을 포함한 시즌을 반환합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthOriginNotAllowed,
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonNotFound,
      SeasonErrorCodes.SeasonStateConflict,
      SeasonErrorCodes.SeasonCapacityReached,
    ],
    { rateLimited: false },
  )
  async join(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<SeasonDetailResponse> {
    const detail = await this.joinSeason.execute(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      id,
    );
    return toSeasonDetailResponse(detail);
  }
}
