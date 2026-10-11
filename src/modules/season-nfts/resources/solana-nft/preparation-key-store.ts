import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createSignerFromKeypair,
  type Signer,
  type Umi,
} from '@metaplex-foundation/umi';
import type { AllConfigType } from '../../../../config/config.type';
import type { SeasonNftNetwork } from '../season-nft/season-nft';

export type PreparationKeyKind = 'collection' | 'machine' | 'guard';

/** Durable preparation identity violations stop automated release work without replacing key material. */
export class PreparationKeyStoreError extends Error {
  constructor(
    readonly code:
      | 'NFT_PREPARATION_KEY_INVALID'
      | 'NFT_PREPARATION_KEY_MISMATCH'
      | 'NFT_PREPARATION_KEY_MISSING',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = PreparationKeyStoreError.name;
  }
}

export type PreparationKey = Readonly<{
  publicKey: string;
  relativePath: string;
  signer: Signer;
}>;

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Existing path components remain private regular directories; symlinks and permissive modes are rejected. */
async function ensurePrivateDirectory(directory: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error: unknown) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ELOOP' || error.code === 'ENOTDIR')
    ) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key directories cannot be symbolic links.',
      );
    }
    throw error;
  }
  let stats;
  try {
    stats = await handle.stat();
  } finally {
    await handle.close();
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw new PreparationKeyStoreError(
      'NFT_PREPARATION_KEY_INVALID',
      'NFT preparation key directories must be non-symlink 0700 directories.',
    );
  }
  return created;
}

/** Persistent signer files use a fixed network/release hierarchy and no-clobber publication. */
@Injectable()
export class PreparationKeyStore {
  constructor(private readonly config: ConfigService<AllConfigType>) {}

  /** Loads a durable signer or publishes one new identity only when DB has no expected address. */
  async loadOrCreate(
    input: Readonly<{
      network: SeasonNftNetwork;
      releaseId: string;
      kind: PreparationKeyKind;
      expectedPublicKey?: string;
      umi: Pick<Umi, 'eddsa'>;
    }>,
  ): Promise<PreparationKey> {
    const root = this.config.get('seasonNft.preparationKeyDir', {
      infer: true,
    });
    if (!root || !path.isAbsolute(root)) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key root must be an absolute path.',
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input.releaseId,
      )
    ) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT release ID is invalid for preparation key storage.',
      );
    }

    // Validate the configured path itself before resolving it so a root symlink cannot bypass O_NOFOLLOW.
    await ensurePrivateDirectory(root);
    const rootRealPath = await realpath(root);
    const networkDirectory = path.join(rootRealPath, input.network);
    if (await ensurePrivateDirectory(networkDirectory))
      await syncDirectory(rootRealPath);
    const releaseDirectory = path.join(
      networkDirectory,
      input.releaseId.toLowerCase(),
    );
    if (await ensurePrivateDirectory(releaseDirectory))
      await syncDirectory(networkDirectory);
    const relativePath = `${input.network}/${input.releaseId.toLowerCase()}/${input.kind}.json`;
    const finalPath = path.join(rootRealPath, relativePath);

    const existing = await this.loadExisting(finalPath, input.umi);
    if (existing) {
      // Adoption also fsyncs the containing directory so a prior link-before-crash becomes durable.
      await syncDirectory(releaseDirectory);
      this.assertExpected(existing.publicKey, input.expectedPublicKey);
      return { ...existing, relativePath };
    }
    // A persisted DB address without its private file cannot be regenerated safely.
    if (input.expectedPublicKey) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_MISSING',
        'NFT preparation key file is missing for a persisted public address.',
      );
    }

    const generated = input.umi.eddsa.generateKeypair();
    const bytes = Buffer.from(
      `${JSON.stringify([...generated.secretKey])}\n`,
      'utf8',
    );
    const temporaryPath = path.join(
      releaseDirectory,
      `.${input.kind}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let published = false;
    try {
      await link(temporaryPath, finalPath);
      published = true;
      await syncDirectory(releaseDirectory);
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    if (!published) await syncDirectory(releaseDirectory);

    // A concurrent publisher may win; always adopt only the validated final file.
    const durable = await this.loadExisting(finalPath, input.umi);
    if (!durable) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key publication did not create a durable final file.',
      );
    }
    if (published) {
      const generatedPublicKey = String(
        createSignerFromKeypair(input.umi, generated).publicKey,
      );
      this.assertExpected(durable.publicKey, generatedPublicKey);
    }
    return { ...durable, relativePath };
  }

  private async loadExisting(
    filePath: string,
    umi: Pick<Umi, 'eddsa'>,
  ): Promise<Omit<PreparationKey, 'relativePath'> | null> {
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ELOOP'
      ) {
        throw new PreparationKeyStoreError(
          'NFT_PREPARATION_KEY_INVALID',
          'NFT preparation keys cannot be symbolic links.',
        );
      }
      throw error;
    }
    let source: string;
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size <= 0 ||
        stats.size > 1024
      ) {
        throw new PreparationKeyStoreError(
          'NFT_PREPARATION_KEY_INVALID',
          'NFT preparation keys must be small regular 0600 files.',
        );
      }
      source = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key file is not valid JSON.',
        { cause: error },
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every(
        (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
      )
    ) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key file must contain a 64-byte Ed25519 secret.',
      );
    }
    try {
      const signer = createSignerFromKeypair(
        umi,
        umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(parsed)),
      );
      return { publicKey: String(signer.publicKey), signer };
    } catch (error: unknown) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_INVALID',
        'NFT preparation key file contains invalid Ed25519 material.',
        { cause: error },
      );
    }
  }

  private assertExpected(actual: string, expected?: string): void {
    if (expected !== undefined && actual !== expected) {
      throw new PreparationKeyStoreError(
        'NFT_PREPARATION_KEY_MISMATCH',
        'NFT preparation key does not match the persisted public address.',
      );
    }
  }
}
