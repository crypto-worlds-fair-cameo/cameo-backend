import { lstat, readFile } from 'node:fs/promises';
import { TurboFactory } from '@ardrive/turbo-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bs58 from 'bs58';
import type { AllConfigType } from '../../../../config/config.type';

export type MediaDataItemTag = Readonly<{ name: string; value: string }>;

export type SignMediaItemInput = Readonly<{
  bytes: Uint8Array;
  tags: readonly MediaDataItemTag[];
}>;

export type UploadMediaItemInput = Readonly<{
  signedItemBytes: Uint8Array;
  dataItemId: string;
  tags: readonly MediaDataItemTag[];
  signal?: AbortSignal;
}>;

export type MediaUploadReceipt = Readonly<
  Record<string, unknown> & { id: string }
>;

export abstract class TurboMediaTransport {
  abstract signerPublicKey(): Promise<Uint8Array>;
  abstract sign(input: SignMediaItemInput): Promise<Uint8Array>;
  abstract upload(input: UploadMediaItemInput): Promise<MediaUploadReceipt>;
}

type TurboClient = ReturnType<typeof TurboFactory.authenticated>;

async function streamBytes(stream: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(stream) || stream instanceof Uint8Array)
    return Buffer.from(stream);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** 설정한 서비스 Solana key와 Turbo 2.1.0 API로 signed data item 생성과 재전송을 담당한다. */
@Injectable()
export class TurboSdkMediaTransport extends TurboMediaTransport {
  private clientPromise?: Promise<TurboClient>;

  constructor(private readonly config: ConfigService<AllConfigType>) {
    super();
  }

  /** orphan 검증이 현재 서비스 서명자만 채택하도록 SDK가 사용하는 raw public key를 반환한다. */
  async signerPublicKey(): Promise<Uint8Array> {
    return Buffer.from(await (await this.client()).signer.getPublicKey());
  }

  /** 원본 media bytes와 고정 tags를 ANS-104 data item 하나로 서명한다. */
  async sign(input: SignMediaItemInput): Promise<Uint8Array> {
    const bytes = Buffer.from(input.bytes);
    const signed = await (
      await this.client()
    ).signer.signDataItem({
      fileStreamFactory: () => Buffer.from(bytes),
      fileSizeFactory: () => bytes.length,
      dataItemOpts: { tags: input.tags.map((tag) => ({ ...tag })) },
    });
    const signedBytes = await streamBytes(signed.dataItemStreamFactory());
    if (signed.dataItemSizeFactory() !== signedBytes.length) {
      throw new Error('Turbo signed data item size does not match its bytes.');
    }
    return signedBytes;
  }

  /** 저장소에서 다시 읽은 exact signed bytes를 Turbo에 전송하고 receipt를 그대로 반환한다. */
  async upload(input: UploadMediaItemInput): Promise<MediaUploadReceipt> {
    const bytes = Buffer.from(input.signedItemBytes);
    const receipt = await (
      await this.client()
    ).uploadSignedDataItem({
      dataItemStreamFactory: () => Buffer.from(bytes),
      dataItemSizeFactory: () => bytes.length,
      dataItemOpts: { tags: input.tags.map((tag) => ({ ...tag })) },
      // timeout 뒤 결과는 ambiguous로 남고 같은 durable item bytes를 다음 storage job이 재전송한다.
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    return { ...receipt, id: String(receipt.id) };
  }

  private client(): Promise<TurboClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  /** secret file은 최초 media 작업에서 한 번 읽고 private bytes를 로그나 DB에 전달하지 않는다. */
  private async createClient(): Promise<TurboClient> {
    const keyPath = this.required('serviceKeypairPath');
    const stats = await lstat(keyPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error(
        'SOLANA_SERVICE_KEYPAIR_PATH must be a private regular file.',
      );
    }
    const parsed: unknown = JSON.parse(await readFile(keyPath, 'utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every(
        (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
      )
    ) {
      throw new Error(
        'SOLANA_SERVICE_KEYPAIR_PATH must contain a 64-byte Ed25519 secret.',
      );
    }
    const secret = Uint8Array.from(parsed as number[]);
    return TurboFactory.authenticated({
      privateKey: bs58.encode(secret),
      token: 'solana',
      gatewayUrl: this.required('rpcUrl'),
      uploadServiceConfig: { url: this.required('storageUploadUrl') },
      paymentServiceConfig: { url: this.required('storagePaymentUrl') },
    });
  }

  private required(
    key:
      | 'rpcUrl'
      | 'serviceKeypairPath'
      | 'storageUploadUrl'
      | 'storagePaymentUrl',
  ): string {
    const value = this.config.get(`seasonNft.${key}`, { infer: true });
    if (!value) throw new Error(`seasonNft.${key} is required.`);
    return value;
  }
}
