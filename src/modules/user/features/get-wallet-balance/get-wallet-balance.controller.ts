import { Controller, Get, Header, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import { UserErrorCodes } from '../../../../errors/user.error-codes';
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
  GetWalletBalanceUseCase,
  type WalletBalance,
} from './get-wallet-balance.use-case';

class WalletBalanceResponse implements WalletBalance {
  @ApiProperty({ example: '6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L' })
  walletAddress!: string;

  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: SeasonNftNetwork;

  @ApiProperty({
    type: String,
    pattern: '^(0|[1-9][0-9]*)$',
    example: '1222330000000',
    description: 'lamports 단위 10진 문자열. 1 SOL은 1,000,000,000 lamports.',
  })
  lamports!: string;
}

@ApiTags('Users')
@Controller('users/me/balance')
export class GetWalletBalanceController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly getWalletBalance: GetWalletBalanceUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '내 지갑 잔액 조회',
    description:
      '로그인 세션 쿠키가 필요합니다. 현재 세션의 Solana 지갑 잔액을 서버에 설정한 network·RPC에서 confirmed 기준으로 읽습니다. 세션 수명과 쿠키는 변경하지 않습니다.',
  })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(WalletBalanceResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    UserErrorCodes.UserBalanceUnavailable,
  ])
  get(@Req() request: Request): Promise<WalletBalanceResponse> {
    return this.getWalletBalance.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
    );
  }
}
