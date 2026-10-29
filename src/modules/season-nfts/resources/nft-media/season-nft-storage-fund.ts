import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TurboFactory } from '@ardrive/turbo-sdk';
import {
  createNoopSigner,
  publicKey,
  transactionBuilder,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import bs58 from 'bs58';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import {
  setupOperationKey,
  type SeasonNftNetwork,
} from '../season-nft/season-nft';
import { NftTransactionRepository } from '../solana-nft/nft-transaction.repository';
import { TurboMediaTransport } from './turbo-sdk-media-transport';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TRANSFER_COMPUTE_UNIT_LIMIT = 200_000;
const METADATA_HEADROOM_BYTES = 8_192;
/** 발행 미리보기가 저장 회사 응답을 기다리느라 멈추지 않게 견적 조회 시간을 제한한다. */
const QUOTE_TIMEOUT_MS = 5_000;
const umi = createUmi('http://127.0.0.1:8899');

type PaymentClient = ReturnType<typeof TurboFactory.unauthenticated>;

function u32LittleEndian(value: number): number[] {
  return [0, 8, 16, 24].map((shift) => (value >>> shift) & 0xff);
}

function u64LittleEndian(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 0xffn),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Turbo price request timed out.')),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** SOL 금액 문자열을 올림한 lamports로 바꾼다. */
function solToLamports(sol: string): bigint {
  const value = Number(sol);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Turbo storage price is not a SOL amount.');
  }
  return BigInt(Math.ceil(value * 1_000_000_000));
}

/**
 * 그림과 메타데이터 저장 비용은 서비스 지갑이 아니라 개설자 지갑이 낸다.
 * 개설자가 Turbo 입금 거래에 서명하면 크레딧은 파일을 서명하는 서비스 주소로 들어간다.
 */
@Injectable()
export class SeasonNftStorageFund {
  private clientPromise?: Promise<PaymentClient>;

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly transport: TurboMediaTransport,
    private readonly transactions: TransactionRunner,
    private readonly nftTransactions: NftTransactionRepository,
  ) {}

  /** 지금 올릴 바이트와 이후 메타데이터 여유분까지 포함한 lamports 견적을 반환한다. */
  async quoteLamports(byteCount: number): Promise<bigint | null> {
    if (!Number.isSafeInteger(byteCount) || byteCount <= 0) return null;
    try {
      const client = await this.client();
      const price = await withTimeout(
        client.getTokenPriceForBytes({
          byteCount: byteCount + METADATA_HEADROOM_BYTES,
        }),
        QUOTE_TIMEOUT_MS,
      );
      const lamports = solToLamports(price.tokenPrice);
      return lamports > 0n ? lamports : null;
    } catch {
      return null;
    }
  }

  /**
   * 서비스 주소의 Turbo 잔액이 이번 업로드를 내면 true.
   * 부족하면 개설자 서명용 입금 거래를 만들어 두고 false를 반환한다.
   */
  async ensure(
    input: Readonly<{
      releaseId: string;
      network: SeasonNftNetwork;
      creatorWalletAddress: string;
      uploadBytes: number;
      quoteBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<boolean> {
    const client = await this.client();
    const serviceAddress = bs58.encode(
      Buffer.from(await this.transport.signerPublicKey()),
    );
    const required = BigInt(
      (await client.getUploadCosts({ bytes: [input.uploadBytes] }))[0].winc,
    );
    const covered = async () => {
      const balance = await client.getBalance(serviceAddress);
      return BigInt(balance.winc) >= required;
    };
    if (await covered()) return true;

    for (const substep of [0, 1]) {
      const operationKey = setupOperationKey('storage-fund', substep);
      const existing = await this.nftTransactions.findByOperation({
        network: input.network,
        releaseId: input.releaseId,
        operationKey,
      });
      if (
        !existing ||
        existing.state === 'FAILED' ||
        existing.state === 'EXPIRED'
      ) {
        await this.preparePayment({
          ...input,
          operationKey,
          replaceTransactionId: existing?.id,
          serviceAddress,
        });
        return false;
      }
      if (existing.state === 'FINALIZED' || existing.state === 'RECONCILED') {
        if (await covered()) return true;
        let status: 'pending' | 'confirmed' | 'failed' | 'unknown' = 'unknown';
        if (existing.signature) {
          try {
            status = (
              await client.submitFundTransaction({ txId: existing.signature })
            ).status;
          } catch {
            status = 'unknown';
          }
        }
        if (await covered()) return true;
        if (status !== 'confirmed' && status !== 'failed') return false;
        const credited = BigInt((await client.getBalance(serviceAddress)).winc);
        if (credited === 0n) return false;
        continue;
      }
      return false;
    }
    return false;
  }

  private async preparePayment(
    input: Readonly<{
      releaseId: string;
      network: SeasonNftNetwork;
      creatorWalletAddress: string;
      quoteBytes: number;
      signal: AbortSignal;
      operationKey: string;
      replaceTransactionId?: string;
      serviceAddress: string;
    }>,
  ): Promise<void> {
    const client = await this.client();
    const wallets = await client.getTurboCryptoWallets();
    const destination = wallets.solana;
    if (!destination)
      throw new Error('Turbo Solana payment wallet is missing.');
    const price = await client.getTokenPriceForBytes({
      byteCount: input.quoteBytes + METADATA_HEADROOM_BYTES,
    });
    const lamports = solToLamports(price.tokenPrice);
    const checkpoint = await this.latestBlockhash(input.signal);
    const payer = createNoopSigner(publicKey(input.creatorWalletAddress));
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
      .add(budget([2, ...u32LittleEndian(TRANSFER_COMPUTE_UNIT_LIMIT)]))
      .add(budget([3, ...u64LittleEndian(0n)]))
      .add({
        instruction: {
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            {
              pubkey: publicKey(destination),
              isSigner: false,
              isWritable: true,
            },
          ],
          programId: publicKey(SYSTEM_PROGRAM_ID),
          data: Uint8Array.from([
            ...u32LittleEndian(2),
            ...u64LittleEndian(lamports),
          ]),
        },
        signers: [payer],
        bytesCreatedOnChain: 0,
      })
      .add({
        instruction: {
          keys: [],
          programId: publicKey(MEMO_PROGRAM_ID),
          data: Buffer.from(
            `turboCreditDestinationAddress=${input.serviceAddress}`,
          ),
        },
        signers: [],
        bytesCreatedOnChain: 0,
      })
      .setFeePayer(payer)
      .setVersion('legacy')
      .setBlockhash(checkpoint.blockhash)
      .buildAndSign(umi);
    const serializedTransaction = Buffer.from(
      umi.transactions.serialize(transaction),
    );
    if (
      serializedTransaction.length === 0 ||
      serializedTransaction.length > 1232
    ) {
      throw new Error('Season NFT storage payment exceeds the legacy limit.');
    }
    const prepared = {
      network: input.network,
      releaseId: input.releaseId,
      operationKey: input.operationKey,
      kind: 'SETUP_STORAGE_FUND' as const,
      messageHash: createHash('sha256')
        .update(transaction.serializedMessage)
        .digest('hex'),
      serializedTransaction,
      recentBlockhash: checkpoint.blockhash,
      lastValidBlockHeight: checkpoint.lastValidBlockHeight,
      estimatedCostLamports: lamports,
      estimatedAt: new Date(),
    };
    await this.transactions.run((databaseTransaction) =>
      input.replaceTransactionId
        ? this.nftTransactions.replaceExpired(
            {
              transactionId: input.replaceTransactionId,
              replacement: prepared,
            },
            databaseTransaction,
          )
        : this.nftTransactions.insertPrepared(prepared, databaseTransaction),
    );
  }

  private async latestBlockhash(
    signal: AbortSignal,
  ): Promise<Readonly<{ blockhash: string; lastValidBlockHeight: bigint }>> {
    const rpcUrl = this.config.get('seasonNft.rpcUrl', { infer: true });
    if (!rpcUrl) throw new Error('seasonNft.rpcUrl is required.');
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'finalized' }],
      }),
      signal,
    });
    const body = (await response.json()) as {
      result?: {
        value?: { blockhash?: string; lastValidBlockHeight?: number };
      };
      error?: { message?: string };
    };
    const value = body.result?.value;
    if (
      !response.ok ||
      body.error ||
      !value?.blockhash ||
      typeof value.lastValidBlockHeight !== 'number'
    ) {
      throw new Error('Solana blockhash request failed.');
    }
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
    };
  }

  private client(): Promise<PaymentClient> {
    this.clientPromise ??= Promise.resolve(
      TurboFactory.unauthenticated({
        token: 'solana',
        paymentServiceConfig: { url: this.required('storagePaymentUrl') },
        uploadServiceConfig: { url: this.required('storageUploadUrl') },
      }),
    );
    return this.clientPromise;
  }

  private required(key: 'storageUploadUrl' | 'storagePaymentUrl'): string {
    const value = this.config.get(`seasonNft.${key}`, { infer: true });
    if (!value) throw new Error(`seasonNft.${key} is required.`);
    return value;
  }
}
