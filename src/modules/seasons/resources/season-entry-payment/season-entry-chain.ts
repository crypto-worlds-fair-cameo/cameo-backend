import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createNoopSigner,
  publicKey,
  transactionBuilder,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TRANSFER_COMPUTE_UNIT_LIMIT = 5_000;
const RPC_TIMEOUT_MS = 8_000;
// 거래 build에는 RPC가 필요 없으므로 blockhash를 직접 넣고 로컬 주소는 호출하지 않는다.
const umi = createUmi('http://127.0.0.1:8899');

type JsonRpcResponse<T> = Readonly<{
  result?: T;
  error?: Readonly<{ code?: number; message?: string }>;
}>;

/** RPC가 요청을 받아 명시적으로 거절한 오류. 전송 실패와 달리 거래가 전파되지 않았다. */
export class SeasonEntryRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcMessage: string,
  ) {
    super(`Season entry RPC ${method} was rejected.`);
  }
}

export type SeasonEntrySendResult = 'SENT' | 'REJECTED' | 'EXPIRED';

function u64LittleEndian(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 0xffn),
  );
}

function u32LittleEndian(value: number): number[] {
  return [0, 8, 16, 24].map((shift) => (value >>> shift) & 0xff);
}

/** 입장료 SOL 전송 거래를 만들고 서버 설정 RPC로 전송·확정 상태를 조회한다. */
@Injectable()
export class SeasonEntryChain {
  private requestId = 0;

  constructor(private readonly config: ConfigService<AllConfigType>) {}

  /** 입장료를 받을 network와 RPC가 모두 설정되어 있어야 결제를 시작한다. */
  network(): SeasonNftNetwork {
    const network = this.config.get('seasonNft.network', { infer: true });
    const rpcUrl = this.config.get('seasonNft.rpcUrl', { infer: true });
    if ((network !== 'devnet' && network !== 'mainnet-beta') || !rpcUrl)
      throw new BusinessError(ErrorCodes.SeasonEntryFeeUnavailable);
    return network;
  }

  async latestBlockhash(): Promise<
    Readonly<{ blockhash: string; lastValidBlockHeight: bigint }>
  > {
    const result = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return {
      blockhash: result.value.blockhash,
      lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight),
    };
  }

  /** payer 서명만 비워 둔 legacy SystemProgram transfer 거래를 만든다. */
  async buildTransfer(
    input: Readonly<{
      payerAddress: string;
      recipientAddress: string;
      lamports: bigint;
      blockhash: string;
    }>,
  ): Promise<Readonly<{ bytes: Buffer; messageHash: string }>> {
    const payer = createNoopSigner(publicKey(input.payerAddress));
    const budget = (data: number[]) => ({
      instruction: {
        keys: [],
        programId: publicKey(COMPUTE_BUDGET_PROGRAM_ID),
        data: Uint8Array.from(data),
      },
      signers: [],
      bytesCreatedOnChain: 0,
    });
    const transaction = await transactionBuilder()
      // 0 수수료까지 명시해 지갑이 budget 명령을 추가하며 준비한 message를 바꾸지 않게 한다.
      .add(budget([2, ...u32LittleEndian(TRANSFER_COMPUTE_UNIT_LIMIT)]))
      .add(budget([3, ...u64LittleEndian(0n)]))
      .add({
        instruction: {
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            {
              pubkey: publicKey(input.recipientAddress),
              isSigner: false,
              isWritable: true,
            },
          ],
          programId: publicKey(SYSTEM_PROGRAM_ID),
          data: Uint8Array.from([
            ...u32LittleEndian(2),
            ...u64LittleEndian(input.lamports),
          ]),
        },
        signers: [payer],
        bytesCreatedOnChain: 0,
      })
      .setFeePayer(payer)
      .setVersion('legacy')
      .setBlockhash(input.blockhash)
      .buildAndSign(umi);
    const bytes = Buffer.from(umi.transactions.serialize(transaction));
    if (bytes.length === 0 || bytes.length > 1232)
      throw new Error('Season entry transaction exceeds the legacy limit.');
    return {
      bytes,
      messageHash: createHash('sha256')
        .update(transaction.serializedMessage)
        .digest('hex'),
    };
  }

  /** preflight 거절은 전파되지 않은 거래이므로 실패나 만료로 확정할 수 있다. */
  async send(bytes: Buffer): Promise<SeasonEntrySendResult> {
    try {
      await this.call<string>('sendTransaction', [
        bytes.toString('base64'),
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        },
      ]);
      return 'SENT';
    } catch (error: unknown) {
      if (!(error instanceof SeasonEntryRpcError)) throw error;
      return /blockhash not found/iu.test(error.rpcMessage)
        ? 'EXPIRED'
        : 'REJECTED';
    }
  }

  async signatureStatus(
    signature: string,
  ): Promise<Readonly<{ confirmed: boolean; failed: boolean }> | null> {
    const result = await this.call<{
      value: readonly ({
        confirmationStatus?: string | null;
        err?: unknown;
      } | null)[];
    }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = result.value[0];
    if (!status) return null;
    return {
      failed: status.err !== null && status.err !== undefined,
      confirmed:
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized',
    };
  }

  async finalizedBlockHeight(): Promise<bigint> {
    return BigInt(
      await this.call<number>('getBlockHeight', [{ commitment: 'finalized' }]),
    );
  }

  private async call<T>(
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    const endpoint = this.config.get('seasonNft.rpcUrl', { infer: true });
    if (!endpoint)
      throw new BusinessError(ErrorCodes.SeasonEntryFeeUnavailable);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method,
        params,
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(
        `Season entry RPC request failed with HTTP ${response.status}.`,
      );
    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error)
      throw new SeasonEntryRpcError(method, payload.error.message ?? '');
    if (payload.result === undefined)
      throw new Error(`Season entry RPC ${method} returned no result.`);
    return payload.result;
  }
}
