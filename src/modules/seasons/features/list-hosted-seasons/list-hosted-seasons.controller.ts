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
import { HostedSeasonsResponse } from './hosted-seasons.response';
import { ListHostedSeasonsUseCase } from './list-hosted-seasons.use-case';

function parseUnsignedInteger(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

export class ListHostedSeasonsQuery {
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
@Controller('seasons/hosted')
export class ListHostedSeasonsController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listHosted: ListHostedSeasonsUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 인증 사용자가 개설한 시즌을 profile용 summary page로 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '개설 시즌 목록 조회',
    description:
      '현재 사용자가 개설한 시즌을 취소·종료 시즌까지 포함해 조회합니다. 결과는 개설 시각과 시즌 ID 내림차순입니다.',
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
  @ApiSuccessResponse(HostedSeasonsResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
  ])
  list(
    @Query() query: ListHostedSeasonsQuery,
    @Req() request: Request,
  ): Promise<HostedSeasonsResponse> {
    return this.listHosted.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      query,
    );
  }
}
