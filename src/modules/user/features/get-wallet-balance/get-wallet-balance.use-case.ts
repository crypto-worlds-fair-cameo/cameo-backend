import { Injectable, Logger } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';
import { SolanaBalanceReader } from '../../resources/wallet-balance/solana-balance.reader';

export type WalletBalance = Readonly<{
  walletAddress: string;
  network: SeasonNftNetwork;
  lamports: string;
}>;

@Injectable()
export class GetWalletBalanceUseCase {
  private readonly logger = new Logger(GetWalletBalanceUseCase.name);

  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly transactions: TransactionRunner,
    private readonly balances: SolanaBalanceReader,
  ) {}

  /** 현재 세션이 서명으로 증명한 지갑의 잔액을 조회한다. RPC 호출 동안 DB 잠금을 잡지 않는다. */
  async execute(token: string | undefined): Promise<WalletBalance> {
    const authentication = await this.transactions.run((transaction) =>
      this.authenticator.authenticate(token, transaction),
    );
    if (authentication.outcome !== 'authenticated') {
      throw new BusinessError(
        authentication.outcome === 'invalid'
          ? ErrorCodes.AuthSessionInvalid
          : ErrorCodes.AuthUserUnavailable,
      );
    }
    try {
      const balance = await this.balances.read(authentication.walletAddress);
      return { walletAddress: authentication.walletAddress, ...balance };
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      this.logger.warn(
        `Wallet balance lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BusinessError(ErrorCodes.UserBalanceUnavailable);
    }
  }
}
