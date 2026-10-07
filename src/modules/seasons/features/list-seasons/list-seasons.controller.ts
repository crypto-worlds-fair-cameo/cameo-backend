import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
import type { SeasonListStatus } from '../../resources/season/season.repository';
import {
  SeasonListResponse,
  toSeasonListResponse,
} from '../../resources/season/season-http';
import { ListSeasonsUseCase } from './list-seasons.use-case';

function parsePositiveInteger(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

class ListSeasonsQuery {
  @Transform(({ value }) => parsePositiveInteger(value))
  @IsInt()
  @Min(1)
  page = 1;

  @Transform(({ value }) => parsePositiveInteger(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['scheduled', 'active', 'ended'])
  status?: SeasonListStatus;
}

@ApiTags('Seasons')
@Controller('seasons')
export class ListSeasonsController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listSeasons: ListSeasonsUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 검증한 페이지 조건과 선택 세션을 전달하고 날짜가 직렬화된 공개 목록을 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 목록 조회',
    description:
      '취소되지 않은 공개 시즌을 생성 시각과 ID의 내림차순으로 조회합니다. 로그인 없이 사용할 수 있으며, 유효한 세션 쿠키가 있으면 참가·개설자 여부와 가능한 동작을 사용자 기준으로 반환합니다. 잘못되거나 사용할 수 없는 세션은 익명으로 처리합니다. Offset pagination이므로 조회 사이에 새 시즌이 추가되거나 필터 대상의 상태가 바뀌면 다음 페이지에 항목이 중복되거나 누락될 수 있습니다.',
    security: [{}, { session: [] }],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1부터 시작하는 페이지 번호.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: '페이지당 시즌 수.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['scheduled', 'active', 'ended'],
    description: '현재 시즌 상태 필터.',
  })
  @ApiSuccessResponse(SeasonListResponse, {
    description: '페이지 정보와 현재 상태가 반영된 공개 시즌 목록입니다.',
  })
  @ApiErrorResponses([], { rateLimited: false })
  async list(
    @Query() query: ListSeasonsQuery,
    @Req() request: Request,
  ): Promise<SeasonListResponse> {
    const page = await this.listSeasons.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      query,
    );
    return toSeasonListResponse(page);
  }
}
