import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DataItem } from '@dha-team/arbundles';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { SeasonNftUploadKind } from '../season-nft/season-nft';
import {
  NftUploadRepository,
  type PreparedUploadRecord,
} from './nft-upload.repository';
import {
  TurboMediaTransport,
  type MediaDataItemTag,
} from './turbo-sdk-media-transport';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';

export const NFT_MEDIA_GATEWAY_FETCH = Symbol('NFT_MEDIA_GATEWAY_FETCH');

export type PublishMediaInput = Readonly<{
  releaseId: string;
  kind: SeasonNftUploadKind;
  bytes: Uint8Array;
  sha256: string;
}>;

export type PublishedMedia = Readonly<{
  uri: string;
  sha256: string;
  dataItemId: string;
}>;

export class TurboMediaPermanentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = TurboMediaPermanentError.name;
  }
}

type GatewayFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

type VerifiedSignedItem = Readonly<{
  bytes: Buffer;
  dataItemId: string;
}>;

const SIGNED_ITEM_OVERHEAD_LIMIT = 8 * 1024;

function mediaMime(kind: SeasonNftUploadKind): string {
  return kind === 'IMAGE' ? 'image/png' : 'application/json';
}

function mediaPath(releaseId: string, kind: SeasonNftUploadKind): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      releaseId,
    )
  ) {
    throw new TurboMediaPermanentError(
      'NFT_MEDIA_INPUT_INVALID',
      'Season NFT media release ID is invalid.',
    );
  }
  return `${releaseId.toLowerCase()}/${kind.toLowerCase()}.signed`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** signed item을 전송 전에 no-clobber final path로 저장하고 directory entry까지 fsync한다. */
async function publishDurableFile(
  directory: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporaryPath = `${directory}/.${fileName}.${randomBytes(8).toString('hex')}.tmp`;
  const finalPath = `${directory}/${fileName}`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, finalPath);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** recursive mkdir가 만든 각 directory entry를 첫 생성 부모부터 upload root까지 순서대로 고정한다. */
async function syncCreatedDirectoryChain(
  firstCreated: string,
  finalDirectory: string,
): Promise<void> {
  const first = resolve(firstCreated);
  const final = resolve(finalDirectory);
  const suffix = relative(first, final);
  if (suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('Created upload directory is outside the configured root.');
  }
  let created = first;
  await syncDirectory(dirname(created));
  for (const segment of suffix.split(sep).filter(Boolean)) {
    await syncDirectory(created);
    created = join(created, segment);
  }
}

/** signed item 저장, DB identity, Turbo receipt, 공개 bytes 검증을 한 storage lane으로 소유한다. */
@Injectable()
export class TurboMediaPublisher {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly transactions: TransactionRunner,
    private readonly uploads: NftUploadRepository,
    private readonly transport: TurboMediaTransport,
    @Inject(NFT_MEDIA_GATEWAY_FETCH)
    private readonly gatewayFetch: GatewayFetch,
  ) {}

  static tagsFor(input: PublishMediaInput): readonly MediaDataItemTag[] {
    return [
      { name: 'Content-Type', value: mediaMime(input.kind) },
      { name: 'App-Name', value: 'Cameo-Season-NFT' },
      { name: 'Cameo-Release-Id', value: input.releaseId.toLowerCase() },
      { name: 'Cameo-Media-Kind', value: input.kind },
      { name: 'File-SHA256', value: input.sha256 },
    ];
  }

  /** exact payload를 한 번 서명·저장하고 같은 item을 receipt와 공개 hash 확인까지 재사용한다. */
  async publish(
    input: PublishMediaInput,
    io: Readonly<{ signal: AbortSignal; assertMayStart: () => void }> = {
      signal: new AbortController().signal,
      assertMayStart: () => {},
    },
  ): Promise<PublishedMedia> {
    const payload = Buffer.from(input.bytes);
    if (
      payload.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.sha256) ||
      sha256(payload) !== input.sha256
    ) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_HASH_MISMATCH',
        'Season NFT media bytes do not match the requested SHA-256.',
      );
    }
    const relativePath = mediaPath(input.releaseId, input.kind);
    const tags = TurboMediaPublisher.tagsFor(input);
    const { directory, filePath } = await this.prepareDirectory(
      input.releaseId,
      input.kind,
    );
    const row = await this.uploads.findItem(input.releaseId, input.kind);
    if (row) this.assertPreparedIdentity(row, input, relativePath);

    // DB item이 있으면 반드시 그 파일을 검증하고, 없으면 deterministic final orphan을 먼저 채택한다.
    let stored = await this.readSignedFile(
      filePath,
      row !== null,
      payload.length,
    );
    if (!stored) {
      const signed = await this.transport.sign({ bytes: payload, tags });
      await publishDurableFile(
        directory,
        `${input.kind.toLowerCase()}.signed`,
        signed,
      );
      stored = await this.readSignedFile(filePath, true, payload.length);
    }
    if (!stored) throw new Error('Durable signed item was not published.');
    const verified = await this.verifySignedItem(
      stored,
      payload,
      tags,
      await this.transport.signerPublicKey(),
    );
    if (row && row.dataItemId !== verified.dataItemId) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_SIGNED_ITEM_INVALID',
        'Durable signed item ID does not match the prepared upload row.',
      );
    }

    // file identity가 확정된 뒤에만 DB row를 만들거나 FAILED row를 같은 item으로 재가동한다.
    const prepared = await withDbOnlyRetry(() =>
      this.transactions.run((transaction) =>
        this.uploads.prepareItem(
          {
            releaseId: input.releaseId,
            kind: input.kind,
            sha256: input.sha256,
            byteLength: BigInt(payload.length),
            dataItemId: verified.dataItemId,
            signedItemPath: relativePath,
          },
          transaction,
        ),
      ),
    );
    const canonicalUri = `https://arweave.net/${verified.dataItemId}`;
    if (prepared.state === 'VERIFIED') {
      if (prepared.uri !== canonicalUri) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Verified media URI does not match its immutable data item ID.',
        );
      }
      return {
        uri: canonicalUri,
        sha256: input.sha256,
        dataItemId: verified.dataItemId,
      };
    }

    if (prepared.state === 'PREPARED') {
      io.assertMayStart();
      io.signal.throwIfAborted();
      const receipt = await this.transport.upload({
        signedItemBytes: verified.bytes,
        dataItemId: verified.dataItemId,
        tags,
        signal: io.signal,
      });
      io.signal.throwIfAborted();
      if (String(receipt.id) !== verified.dataItemId) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Turbo receipt returned a different data item ID.',
        );
      }
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.uploads.recordReceipt(
            {
              uploadId: prepared.uploadId,
              dataItemId: verified.dataItemId,
              receipt,
            },
            transaction,
          ),
        ),
      );
    }

    io.assertMayStart();
    io.signal.throwIfAborted();
    await this.verifyPublicBytes(
      verified.dataItemId,
      payload,
      mediaMime(input.kind),
      io.signal,
    );
    io.signal.throwIfAborted();
    await withDbOnlyRetry(() =>
      this.transactions.run((transaction) =>
        this.uploads.markVerified(
          {
            uploadId: prepared.uploadId,
            dataItemId: verified.dataItemId,
            uri: canonicalUri,
          },
          transaction,
        ),
      ),
    );
    return {
      uri: canonicalUri,
      sha256: input.sha256,
      dataItemId: verified.dataItemId,
    };
  }

  private assertPreparedIdentity(
    row: PreparedUploadRecord,
    input: PublishMediaInput,
    relativePath: string,
  ): void {
    if (
      row.sha256 !== input.sha256 ||
      row.byteLength !== BigInt(input.bytes.byteLength) ||
      row.signedItemPath !== relativePath
    ) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_SIGNED_ITEM_INVALID',
        'Prepared upload identity does not match the frozen media.',
      );
    }
  }

  /** work root와 release directory가 symlink 없는 private0700 directory인지 확인한다. */
  private async prepareDirectory(
    releaseId: string,
    kind: SeasonNftUploadKind,
  ): Promise<Readonly<{ directory: string; filePath: string }>> {
    const configured = this.config.get('seasonNft.uploadWorkDir', {
      infer: true,
    });
    if (!configured) throw new Error('seasonNft.uploadWorkDir is required.');
    const createdRoot = await mkdir(configured, {
      recursive: true,
      mode: 0o700,
    });
    const rootStats = await lstat(configured);
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      (rootStats.mode & 0o777) !== 0o700
    ) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_SIGNED_ITEM_INVALID',
        'NFT upload work directory must be a private 0700 directory.',
      );
    }
    const root = await realpath(configured);
    // 새 upload root entry를 부모 directory에 먼저 fsync해 release directory보다 선행해 보존한다.
    if (createdRoot !== undefined)
      await syncCreatedDirectoryChain(createdRoot, configured);
    const directory = `${root}/${releaseId.toLowerCase()}`;
    const createdRelease = await mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });
    const directoryStats = await lstat(directory);
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      (directoryStats.mode & 0o777) !== 0o700
    ) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_SIGNED_ITEM_INVALID',
        'NFT release upload directory must be a private 0700 directory.',
      );
    }
    // 새 release directory entry를 root에 fsync한 뒤 그 안에 final signed item을 게시한다.
    if (createdRelease !== undefined) await syncDirectory(root);
    return {
      directory,
      filePath: `${directory}/${kind.toLowerCase()}.signed`,
    };
  }

  /** existing DB row의 file은 필수이며, final path가 없을 때만 null orphan slot을 반환한다. */
  private async readSignedFile(
    filePath: string,
    required: boolean,
    payloadLength: number,
  ): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const stats = await handle.stat();
      if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Durable signed item must be a regular 0600 file.',
        );
      }
      const maximum = payloadLength + SIGNED_ITEM_OVERHEAD_LIMIT;
      if (stats.size > maximum) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Durable signed item exceeds the bounded ANS-104 envelope size.',
        );
      }
      const bytes = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      const trailing = await handle.read(extra, 0, 1, offset);
      if (offset !== bytes.length || trailing.bytesRead !== 0) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Durable signed item changed during bounded read.',
        );
      }
      return bytes;
    } catch (error: unknown) {
      if (error instanceof TurboMediaPermanentError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        if (!required) return null;
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_MISSING',
          'Prepared upload is missing its durable signed item.',
          { cause: error },
        );
      }
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ELOOP' || error.code === 'ENOTDIR')
      ) {
        throw new TurboMediaPermanentError(
          'NFT_MEDIA_SIGNED_ITEM_INVALID',
          'Durable signed item path must not contain a symlink or non-directory component.',
          { cause: error },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** ANS-104 signature, signer, payload, tags와 ID를 모두 해석해 검증한 item만 반환한다. */
  private async verifySignedItem(
    bytes: Buffer,
    payload: Buffer,
    tags: readonly MediaDataItemTag[],
    expectedSigner: Uint8Array,
  ): Promise<VerifiedSignedItem> {
    try {
      const item = new DataItem(Buffer.from(bytes));
      if (!(await item.isValid())) throw new Error('Signature is invalid.');
      if (!item.rawOwner.equals(Buffer.from(expectedSigner)))
        throw new Error('Signer is invalid.');
      if (!item.rawData.equals(payload)) throw new Error('Payload is invalid.');
      if (!isDeepStrictEqual(item.tags, tags))
        throw new Error('Tags are invalid.');
      if (!/^[A-Za-z0-9_-]{43}$/.test(item.id))
        throw new Error('Data item ID is invalid.');
      return { bytes: Buffer.from(item.getRaw()), dataItemId: item.id };
    } catch (error: unknown) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_SIGNED_ITEM_INVALID',
        'Durable signed item failed signature, signer, payload, tag, or ID validation.',
        { cause: error },
      );
    }
  }

  /** configurable gateway에서 bytes와 MIME을 확인하되 반환 URI는 canonical Arweave 주소로 고정한다. */
  private async verifyPublicBytes(
    dataItemId: string,
    expectedBytes: Buffer,
    expectedMime: string,
    signal: AbortSignal,
  ): Promise<void> {
    const gateway = this.config.get('seasonNft.storageGatewayUrl', {
      infer: true,
    });
    if (!gateway) throw new Error('seasonNft.storageGatewayUrl is required.');
    const response = await this.gatewayFetch(`${gateway}/${dataItemId}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { 'Accept-Encoding': 'identity' },
    });
    // Gateway propagation delay and transport failures remain retryable on the same upload row.
    if (response.status !== 200) {
      const error = new Error(
        `Permanent gateway returned HTTP ${response.status}.`,
      ) as Error & { code: string };
      error.code = 'NFT_MEDIA_NOT_AVAILABLE';
      throw error;
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase();
    const contentLength = response.headers.get('content-length');
    const contentEncoding = response.headers
      .get('content-encoding')
      ?.trim()
      .toLowerCase();
    // Fetch는 압축 body를 decode하지만 Content-Length는 wire bytes일 수 있어 identity에만 비교한다.
    if (
      contentLength !== null &&
      (contentEncoding === undefined || contentEncoding === 'identity') &&
      (!/^[0-9]+$/.test(contentLength) ||
        BigInt(contentLength) !== BigInt(expectedBytes.length))
    ) {
      await response.body?.cancel();
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_HASH_MISMATCH',
        'Public media Content-Length does not match the prepared bytes.',
      );
    }
    const chunks: Buffer[] = [];
    let downloadedLength = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        downloadedLength += chunk.length;
        if (downloadedLength > expectedBytes.length) {
          await reader.cancel();
          throw new TurboMediaPermanentError(
            'NFT_MEDIA_HASH_MISMATCH',
            'Public media body exceeds the prepared byte length.',
          );
        }
        chunks.push(chunk);
      }
    }
    const downloaded = Buffer.concat(chunks, downloadedLength);
    if (
      downloaded.length !== expectedBytes.length ||
      sha256(downloaded) !== sha256(expectedBytes)
    ) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_HASH_MISMATCH',
        'Public media bytes do not match the prepared bytes.',
      );
    }
    if (contentType !== expectedMime) {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_MIME_MISMATCH',
        'Public media Content-Type does not match the prepared media kind.',
      );
    }
  }
}
