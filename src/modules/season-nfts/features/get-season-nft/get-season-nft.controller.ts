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
import { SeasonErrorCodes } from '../../../seasons/resources/season/season.error-codes';
import { SeasonNftErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { GetSeasonNftUseCase } from './get-season-nft.use-case';
import { SeasonNftResponse } from './get-season-nft.response';

@ApiTags('Season NFTs')
@Controller('seasons/:seasonId/nft')
export class GetSeasonNftController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly getSeasonNft: GetSeasonNftUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 인증 사용자의 참가·usage·claim만 현재 network의 시즌 NFT 상태로 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 NFT 상태 조회',
    description:
      '현재 로그인 사용자의 참가 지갑, 서버 획 사용량, 수령 상태를 현재 서버 network 기준으로 조회합니다. 외부 RPC나 저장소를 호출하지 않습니다.',
  })
  @ApiCookieAuth('session')
  @ApiParam({ name: 'seasonId', format: 'uuid', description: '시즌 ID.' })
  @ApiSuccessResponse(SeasonNftResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    SeasonErrorCodes.SeasonNotFound,
    SeasonNftErrorCodes.NftServiceUnavailable,
  ])
  get(
    @Param('seasonId', new ParseUUIDPipe({ version: '4' })) seasonId: string,
    @Req() request: Request,
  ): Promise<SeasonNftResponse> {
    return this.getSeasonNft.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      seasonId,
    );
  }
}
