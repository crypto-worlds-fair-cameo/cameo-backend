import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
import { SeasonErrorCodes } from '../../../seasons/resources/season/season.error-codes';
import {
  ListSeasonHoldersUseCase,
  MAX_SEASON_HOLDERS_LIMIT,
  MAX_SEASON_HOLDERS_SEARCH_LENGTH,
  type SeasonHoldersPage,
} from './list-season-holders.use-case';

export class SeasonHolderResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '참가자의 현재 표시 이름. 설정하지 않았으면 null입니다.',
  })
  displayName!: string | null;

  @ApiProperty({ description: '참가 시 고정한 Solana 지갑 주소.' })
  walletAddress!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 1,
    nullable: true,
    description: '수령한 시즌 NFT 수량. 아직 수령하지 않았으면 null입니다.',
  })
  amount!: number | null;
}

export class SeasonHoldersCollectionResponse {
  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: 'devnet' | 'mainnet-beta';

  @ApiProperty({ description: '시즌 NFT 컬렉션 주소.' })
  address!: string;
}

export class SeasonHoldersResponse {
  @ApiProperty({ type: () => SeasonHolderResponse, isArray: true })
  items!: SeasonHolderResponse[];

  @ApiProperty({ type: 'integer', minimum: 1 })
  page!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  limit!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색 조건에 맞는 전체 참가자 수.',
  })
  total!: number;

  @ApiProperty({
    type: () => SeasonHoldersCollectionResponse,
    nullable: true,
    description: '시즌 NFT 준비가 끝난 경우에만 제공하는 컬렉션 정보.',
  })
  collection!: SeasonHoldersCollectionResponse | null;
}

function parsePositiveInteger(value: unknown): unknown {
  // 10진 양의 정수 정규형만 number로 바꾸고 나머지는 validator가 거절하게 둔다.
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return value;
  const parsed = Number(value);
  // JS 안전 정수 범위를 넘은 문자열은 원문을 유지해 정수 검증을 실패시킨다.
  return Number.isSafeInteger(parsed) ? parsed : value;
}

class ListSeasonHoldersQueryParams {
  @Transform(({ value }) => parsePositiveInteger(value))
  @IsInt()
  @Min(1)
  page = 1;

  @Transform(({ value }) => parsePositiveInteger(value))
  @IsInt()
  @Min(1)
  @Max(MAX_SEASON_HOLDERS_LIMIT)
  limit = 10;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEASON_HOLDERS_SEARCH_LENGTH)
  search?: string;
}

function toSeasonHoldersResponse(
  page: SeasonHoldersPage,
): SeasonHoldersResponse {
  return {
    items: page.items.map((item) => ({
      displayName: item.displayName,
      walletAddress: item.walletAddress,
      amount: item.amount,
    })),
    page: page.page,
    limit: page.limit,
    total: page.total,
    collection: page.collection && { ...page.collection },
  };
}

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/holders')
export class ListSeasonHoldersController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listHolders: ListSeasonHoldersUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 선택 세션과 검증한 페이지 조건을 전달하고 공개 필드만 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 NFT 보유자 목록 조회',
    description:
      '개설자와, 유료 시즌이면 입장료 결제가 확정된 참가자, 무료 시즌이면 획을 하나 이상 남긴 참가자의 표시 이름, 참가 지갑, 현재 서버 network에서 수령한 NFT 수량을 조회합니다. 개설자가 맨 앞이고 나머지는 참가 순서입니다. search는 표시 이름이나 지갑 주소의 부분 일치(대소문자 무시)입니다. 취소된 시즌은 개설자만, 지갑 보유자 전용 시즌은 로그인한 사용자만 조회할 수 있습니다. 잘못되거나 사용할 수 없는 세션은 익명으로 처리합니다.',
    security: [{}, { session: [] }],
  })
  @ApiParam({ name: 'seasonId', format: 'uuid', description: '시즌 ID.' })
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1부터 시작하는 페이지 번호.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEASON_HOLDERS_LIMIT,
      default: 10,
    },
    description: '페이지당 참가자 수.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    schema: { type: 'string', maxLength: MAX_SEASON_HOLDERS_SEARCH_LENGTH },
    description: '표시 이름 또는 지갑 주소 검색어.',
  })
  @ApiSuccessResponse(SeasonHoldersResponse, {
    description:
      '개설자를 맨 앞에 두고 참가 순서대로 정렬한 참가자와 전체 수, 컬렉션 정보입니다.',
  })
  @ApiErrorResponses([SeasonErrorCodes.SeasonNotFound], {
    rateLimited: false,
  })
  async list(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Query() query: ListSeasonHoldersQueryParams,
    @Req() request: Request,
  ): Promise<SeasonHoldersResponse> {
    const page = await this.listHolders.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      {
        seasonId,
        page: query.page,
        limit: query.limit,
        search: query.search,
      },
    );
    return toSeasonHoldersResponse(page);
  }
}
