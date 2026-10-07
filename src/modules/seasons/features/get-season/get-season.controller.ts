import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
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
import { GetSeasonUseCase } from './get-season.use-case';

@ApiTags('Seasons')
@Controller('seasons/:id')
export class GetSeasonController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly getSeason: GetSeasonUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 공개 상세에 선택 세션 기준 참가·개설자 권한을 반영하고 날짜를 ISO 문자열로 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 상세 조회',
    description:
      '공개 시즌은 로그인 없이 조회할 수 있습니다. 유효한 세션 쿠키가 있으면 참가·개설자 여부와 가능한 동작을 사용자 기준으로 반환합니다. 잘못되거나 사용할 수 없는 세션은 익명으로 처리합니다. 취소된 시즌은 개설자만 조회할 수 있습니다.',
    security: [{}, { session: [] }],
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: '조회할 시즌과 캔버스의 공통 ID.',
  })
  @ApiSuccessResponse(SeasonDetailResponse, {
    description: '현재 상태와 조회 사용자 기준 권한을 포함한 시즌입니다.',
  })
  @ApiErrorResponses([SeasonErrorCodes.SeasonNotFound], {
    rateLimited: false,
  })
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<SeasonDetailResponse> {
    const detail = await this.getSeason.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      id,
    );
    return toSeasonDetailResponse(detail);
  }
}
