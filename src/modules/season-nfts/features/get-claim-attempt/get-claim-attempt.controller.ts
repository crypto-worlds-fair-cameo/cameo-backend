import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
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
import { SeasonNftErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { ClaimAttemptResponse } from './get-claim-attempt.response';
import { GetClaimAttemptUseCase } from './get-claim-attempt.use-case';

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/nft/claim-attempts/:attemptId')
export class GetClaimAttemptController {
  private readonly cookies: ReturnType<typeof authCookies>;
  constructor(
    private readonly getAttempt: GetClaimAttemptUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 로그인 actor 소유 시도의 현재 DB 상태와 서명 가능한 거래만 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '시즌 NFT 수령 시도 조회' })
  @ApiCookieAuth('session')
  @ApiParam({ name: 'seasonId', format: 'uuid' })
  @ApiParam({ name: 'attemptId', format: 'uuid' })
  @ApiSuccessResponse(ClaimAttemptResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonNftErrorCodes.NftClaimAttemptNotFound,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  get(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Param('attemptId', new ParseUUIDPipe({ version: '4' })) attemptId: string,
    @Req() request: Request,
  ): Promise<ClaimAttemptResponse> {
    return this.getAttempt.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
      attemptId,
    );
  }
}
