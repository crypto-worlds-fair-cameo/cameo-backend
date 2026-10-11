import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
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
import { SeasonNftErrorCodes } from '../../../season-nfts/resources/season-nft/season-nft.error-codes';
import { ListParticipatedSeasonsUseCase } from './list-participated-seasons.use-case';
import { ParticipatedSeasonsResponse } from './participated-seasons.response';

function parseUnsignedInteger(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

export class ListParticipatedSeasonsQuery {
  @Transform(({ value }) => parseUnsignedInteger(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @Transform(({ value }) => parseUnsignedInteger(value))
  @IsInt()
  @Min(0)
  offset = 0;
}

@ApiTags('Seasons')
@Controller('seasons/participated')
export class ListParticipatedSeasonsController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listParticipated: ListParticipatedSeasonsUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 인증 사용자의 참가 기록을 profile용 시즌·NFT summary page로 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '참여 시즌 목록 조회',
    description:
      '개설자 자동 참가와 종료·취소 시즌을 포함한 현재 사용자의 실제 참가 기록을 조회합니다. 결과는 참가 시각과 시즌 ID 내림차순이며 외부 RPC나 저장소를 호출하지 않습니다.',
  })
  @ApiCookieAuth('session')
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    schema: { type: 'integer', minimum: 0, default: 0 },
  })
  @ApiSuccessResponse(ParticipatedSeasonsResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  list(
    @Query() query: ListParticipatedSeasonsQuery,
    @Req() request: Request,
  ): Promise<ParticipatedSeasonsResponse> {
    return this.listParticipated.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      query,
    );
  }
}
