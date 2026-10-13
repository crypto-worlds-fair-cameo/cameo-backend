import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiProperty,
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
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';
import {
  ListTransactionsUseCase,
  type TransactionItem,
  type TransactionsPage,
} from './list-transactions.use-case';

function parseUnsignedInteger(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

export class ListTransactionsQuery {
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

class TransactionResponse implements TransactionItem {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['season_entry'] })
  type!: 'season_entry';

  @ApiProperty({
    enum: ['outgoing', 'incoming'],
    description:
      'outgoing은 내가 낸 입장료, incoming은 내 시즌으로 받은 입장료.',
  })
  direction!: 'outgoing' | 'incoming';

  @ApiProperty({ format: 'uuid' })
  seasonId!: string;

  @ApiProperty({ minLength: 1, maxLength: 50 })
  seasonTitle!: string;

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]*$',
    example: '10000000',
    description: 'lamports 단위 10진 문자열.',
  })
  lamports!: string;

  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: SeasonNftNetwork;

  @ApiProperty({ description: '확정된 Solana 거래 서명.' })
  signature!: string;

  @ApiProperty({
    format: 'date-time',
    description: '서버가 거래 확정을 기록한 시각.',
  })
  occurredAt!: string;
}

class TransactionsResponse implements TransactionsPage {
  @ApiProperty({ type: () => TransactionResponse, isArray: true })
  items!: TransactionResponse[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  total!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50, default: 20 })
  limit!: number;

  @ApiProperty({ type: 'integer', minimum: 0, default: 0 })
  offset!: number;
}

@ApiTags('Users')
@Controller('users/me/transactions')
export class ListTransactionsController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listTransactions: ListTransactionsUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '내 거래 내역 조회',
    description:
      '로그인 세션 쿠키가 필요합니다. 확정된 시즌 입장료 결제 중 내가 보낸 것과 내가 개설한 시즌으로 받은 것을 최신순으로 반환합니다. 외부 RPC를 호출하지 않습니다.',
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
  @ApiSuccessResponse(TransactionsResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
  ])
  list(
    @Query() query: ListTransactionsQuery,
    @Req() request: Request,
  ): Promise<TransactionsResponse> {
    return this.listTransactions.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      query,
    );
  }
}
