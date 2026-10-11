import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
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
import { SeasonNftErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { SubmitClaimTransactionUseCase } from './submit-claim-transaction.use-case';

class SubmitClaimTransactionBody {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  transactionId!: string;

  @ApiProperty({
    maxLength: 1644,
    description: 'Canonical padded Base64 legacy transaction.',
  })
  @IsString()
  @MaxLength(1644)
  @Matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  signedTransactionBase64!: string;
}

class SubmitClaimTransactionResponse {
  @ApiProperty({ format: 'uuid' }) attemptId!: string;
  @ApiProperty({
    enum: [
      'QUEUED',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'CONFIRMING',
      'SUCCEEDED',
      'FAILED',
      'EXPIRED',
    ],
  })
  state!: string;
  @ApiProperty() signature!: string;
}

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/nft/claim-attempts/:attemptId/transactions')
export class SubmitClaimTransactionController {
  private readonly cookies: ReturnType<typeof authCookies>;
  constructor(
    private readonly submitClaim: SubmitClaimTransactionUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** canonical body와 actor를 전달하고 signed bytes DB commit 결과에 따라 202 또는 replay 200을 반환한다. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '서명한 시즌 NFT 거래 접수' })
  @ApiCookieAuth('session')
  @ApiParam({ name: 'seasonId', format: 'uuid' })
  @ApiParam({ name: 'attemptId', format: 'uuid' })
  @ApiSuccessResponse(SubmitClaimTransactionResponse, { status: 200 })
  @ApiSuccessResponse(SubmitClaimTransactionResponse, { status: 202 })
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonNftErrorCodes.NftClaimAttemptNotFound,
    SeasonNftErrorCodes.NftTransactionInvalid,
    SeasonNftErrorCodes.NftTransactionInvalidState,
    SeasonNftErrorCodes.NftTransactionExpired,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  async submit(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Param('attemptId', new ParseUUIDPipe({ version: '4' })) attemptId: string,
    @Body() body: SubmitClaimTransactionBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitClaimTransactionResponse> {
    const result = await this.submitClaim.execute({
      origin: request.headers.origin,
      token: readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
      attemptId,
      transactionId: body.transactionId,
      signedTransactionBase64: body.signedTransactionBase64,
    });
    response.status(result.accepted ? 202 : 200);
    return {
      attemptId: result.attemptId,
      state: result.state,
      signature: result.signature,
    };
  }
}
