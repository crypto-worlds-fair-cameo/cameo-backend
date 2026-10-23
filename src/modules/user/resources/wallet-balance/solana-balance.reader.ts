import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';

const RPC_TIMEOUT_MS = 8_000;

/** 서버에 설정한 Solana network와 RPC로만 지갑 잔액을 읽는다. 브라우저는 RPC를 직접 호출하지 않는다. */
@Injectable()
export class SolanaBalanceReader {
  constructor(private readonly config: ConfigService<AllConfigType>) {}

  async read(
    address: string,
  ): Promise<Readonly<{ network: SeasonNftNetwork; lamports: string }>> {
    const network = this.config.get('seasonNft.network', { infer: true });
    const endpoint = this.config.get('seasonNft.rpcUrl', { infer: true });
    if ((network !== 'devnet' && network !== 'mainnet-beta') || !endpoint)
      throw new BusinessError(ErrorCodes.UserBalanceUnavailable);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address, { commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(
        `Balance RPC request failed with HTTP ${response.status}.`,
      );
    const payload = (await response.json()) as {
      result?: { value?: unknown };
      error?: { message?: string };
    };
    const value = payload.result?.value;
    if (
      payload.error ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0
    )
      throw new Error(
        `Balance RPC returned an invalid result: ${payload.error?.message ?? 'no value'}.`,
      );
    return { network, lamports: BigInt(value).toString() };
  }
}
