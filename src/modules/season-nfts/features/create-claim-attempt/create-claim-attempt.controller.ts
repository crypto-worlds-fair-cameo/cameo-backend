import {
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
  ApiTags,
} from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
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
import { SeasonErrorCodes } from '../../../seasons/resources/season/season.error-codes';
import { SeasonNftErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { CreateClaimAttemptUseCase } from './create-claim-attempt.use-case';

class CreateClaimAttemptResponse {
  @ApiProperty({ format: 'uuid', nullable: true })
  attemptId!: string | null;

  @ApiProperty({
    enum: [
      'QUEUED',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'CONFIRMING',
      'CLAIMED',
    ],
  })
  state!: string;
}

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/nft/claim-attempts')
export class CreateClaimAttemptController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly createClaim: CreateClaimAttemptUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** Origin과 세션을 검증한 뒤 수령 시도를 DB에 접수하고 체인 완료를 기다리지 않는다. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '시즌 NFT 수령 시도 생성 또는 재사용' })
  @ApiCookieAuth('session')
  @ApiParam({ name: 'seasonId', format: 'uuid', description: '시즌 ID.' })
  @ApiSuccessResponse(CreateClaimAttemptResponse, { status: 200 })
  @ApiSuccessResponse(CreateClaimAttemptResponse, { status: 202 })
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonErrorCodes.SeasonNotFound,
    SeasonNftErrorCodes.NftNotEligible,
    SeasonNftErrorCodes.NftWalletMismatch,
    SeasonNftErrorCodes.NftSeasonUnavailable,
    SeasonNftErrorCodes.NftNotReady,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  async create(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateClaimAttemptResponse> {
    const result = await this.createClaim.execute(
      request.headers.origin,
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
    );
    response.status(result.created ? 202 : 200);
    return result.result;
  }
}
