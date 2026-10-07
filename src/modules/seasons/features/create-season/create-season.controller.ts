import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsString, ValidateIf } from 'class-validator';
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
import type { CreateSeasonInput } from '../../resources/season/season';
import { SeasonErrorCodes } from '../../resources/season/season.error-codes';
import {
  SeasonDetailResponse,
  toSeasonDetailResponse,
} from '../../resources/season/season-http';
import { CreateSeasonUseCase } from './create-season.use-case';

class CreateSeasonBody implements CreateSeasonInput {
  @ApiProperty({
    minLength: 1,
    maxLength: 50,
    example: '가을 공동 캔버스',
    description: '앞뒤 공백을 제거한 Unicode code point 기준 1~50자 제목.',
  })
  @IsString()
  title!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 100,
    example: '30일 동안 함께 완성하는 공개 캔버스',
    description:
      '앞뒤 공백을 제거한 최대 100자 설명. 생략하거나 빈 문자열이면 null로 저장하며 null 입력은 허용하지 않습니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 500,
    maximum: 10000,
    default: 1000,
    example: 1000,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  width?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 500,
    maximum: 10000,
    default: 1000,
    example: 1000,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  height?: number;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: 10,
    default: 1,
    example: 3,
    description: '사용자별 획 제한. null이면 무제한입니다.',
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  strokeLimitPerUser?: number | null;

  @ApiProperty({ type: 'integer', minimum: 2, maximum: 100, example: 20 })
  @IsInt()
  capacity!: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-10-07T09:00:00.000+09:00',
    description:
      '시작 시각. 생략하면 인증 후 DB 시각에 즉시 시작하며, 예약은 그 시각부터 최대 30일 이내입니다. 시각대가 필요하며 소수 초는 최대 3자리입니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  startsAt?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-08T09:00:00.000+09:00',
    description:
      '필수 종료 시각. 시작부터 1시간 이상 30일 이하이며, 시각대가 필요하고 소수 초는 최대 3자리입니다.',
  })
  @IsString()
  endsAt!: string;
}

@ApiTags('Seasons')
@Controller('seasons')
export class CreateSeasonController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly createSeason: CreateSeasonUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 검증한 설정과 현재 세션만 업무 흐름에 전달하고 날짜를 ISO 문자열로 반환한다. */
  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 개설',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 개설과 개설자의 자동 참가는 무료이며 모든 시즌은 공개입니다. 시즌 캔버스와 개설자의 참가 기록을 함께 생성합니다. 다른 사용자는 참가 API로 진행 중인 시즌에 참가할 수 있습니다. 개설자는 대기·진행 시즌을 최대 3개 보유할 수 있습니다. 같은 요청을 다시 보내면 새 ID의 시즌을 생성합니다.',
  })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiBody({ type: CreateSeasonBody, required: true })
  @ApiSuccessResponse(SeasonDetailResponse, {
    status: 201,
    description: '시즌·캔버스·개설자 참가 기록을 생성합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthOriginNotAllowed,
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonInputInvalid,
      SeasonErrorCodes.SeasonActiveLimitReached,
    ],
    { rateLimited: false },
  )
  async create(
    @Body() body: CreateSeasonBody,
    @Req() request: Request,
  ): Promise<SeasonDetailResponse> {
    const detail = await this.createSeason.execute(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      body,
    );
    return toSeasonDetailResponse(detail);
  }
}
