import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
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
import { SeasonErrorCodes } from '../../../seasons/resources/season/season.error-codes';
import { SeasonNftErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { RequestSeasonNftMintUseCase } from './request-season-nft-mint.use-case';

class MintTransactionBody {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  transactionId!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  @MaxLength(1644)
  signedTransactionBase64!: string;
}

class RequestMintBody {
  @ApiProperty({ description: '총 발행 수량. 받을 사람 수 이상입니다.' })
  @IsString()
  @Matches(/^[1-9][0-9]{0,15}$/u)
  supply!: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

class PendingMintTransactionResponse {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty()
  serializedTransactionBase64!: string;

  @ApiProperty({ enum: ['SETUP', 'CREATOR_MINT'] })
  purpose!: 'SETUP' | 'CREATOR_MINT';
}

class SeasonNftMintResponse {
  @ApiProperty({ format: 'uuid' })
  seasonId!: string;

  @ApiProperty({
    enum: [
      'NONE',
      'WAITING_SNAPSHOT',
      'PREPARING',
      'READY',
      'EMPTY',
      'BLOCKED',
    ],
  })
  status!: string;

  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  startsAt!: string;

  @ApiProperty()
  endsAt!: string;

  @ApiProperty()
  eligibleCount!: number;

  @ApiProperty()
  minSupply!: string;

  @ApiProperty()
  supply!: string;

  @ApiProperty()
  creatorAllocation!: string;

  @ApiProperty()
  strokeCount!: string;

  @ApiProperty({ nullable: true })
  imageUrl!: string | null;

  @ApiProperty({ nullable: true })
  estimatedLamports!: string | null;

  @ApiProperty()
  walletAddress!: string;

  @ApiProperty()
  mintedCount!: string;

  @ApiProperty()
  signatureCount!: number;

  @ApiProperty({ nullable: true })
  collectionAddress!: string | null;

  @ApiProperty({ type: PendingMintTransactionResponse, nullable: true })
  pendingTransaction!: PendingMintTransactionResponse | null;
}

class SubmitMintTransactionResponse {
  @ApiProperty()
  accepted!: boolean;

  @ApiProperty()
  signature!: string;
}

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/nft/mint')
export class RequestSeasonNftMintController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly mint: RequestSeasonNftMintUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: '시즌 NFT 발행 미리보기' })
  @ApiParam({ name: 'seasonId', format: 'uuid' })
  @ApiSuccessResponse(SeasonNftMintResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonErrorCodes.SeasonNotFound,
    SeasonNftErrorCodes.NftMintNotCreator,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  preview(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Query('supply') supply: string | undefined,
    @Req() request: Request,
  ) {
    return this.mint.preview(
      request.headers.origin,
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
      supply,
    );
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: '시즌 NFT 발행 요청' })
  @ApiParam({ name: 'seasonId', format: 'uuid' })
  @ApiSuccessResponse(SeasonNftMintResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonErrorCodes.SeasonNotFound,
    SeasonNftErrorCodes.NftMintNotCreator,
    SeasonNftErrorCodes.NftMintNotEnded,
    SeasonNftErrorCodes.NftMintSupplyTooSmall,
    SeasonNftErrorCodes.NftMintAllocationTooLarge,
    SeasonNftErrorCodes.NftWalletMismatch,
    SeasonNftErrorCodes.NftSeasonUnavailable,
    SeasonNftErrorCodes.NftNotReady,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  request(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Body() body: RequestMintBody,
    @Req() request: Request,
  ) {
    return this.mint.request(
      request.headers.origin,
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
      body.supply,
      body.description,
    );
  }

  @Post('transactions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: '시즌 NFT 발행 거래 서명 제출' })
  @ApiParam({ name: 'seasonId', format: 'uuid' })
  @ApiSuccessResponse(SubmitMintTransactionResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonNftErrorCodes.NftMintNotCreator,
    SeasonNftErrorCodes.NftWalletMismatch,
    SeasonNftErrorCodes.NftTransactionInvalid,
    SeasonNftErrorCodes.NftTransactionInvalidState,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  submit(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Body() body: MintTransactionBody,
    @Req() request: Request,
  ) {
    return this.mint.submit(
      request.headers.origin,
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
      body.transactionId,
      body.signedTransactionBase64,
    );
  }
}
