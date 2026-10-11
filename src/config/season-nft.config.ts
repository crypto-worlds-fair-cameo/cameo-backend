import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { registerAs } from '@nestjs/config';
import type { SeasonNftNetwork } from '../modules/season-nfts/resources/season-nft/season-nft';

export type SeasonNftConfig = {
  enabled: boolean;
  network: SeasonNftNetwork | null;
  rpcUrl?: string;
  serviceKeypairPath?: string;
  storageUploadUrl?: string;
  storagePaymentUrl?: string;
  storageGatewayUrl?: string;
  uploadWorkDir?: string;
  preparationKeyDir?: string;
  rpcReadRps: number;
  rpcSendIntervalMs: number;
  priorityFeeMaxLamports: bigint;
};

/** boolean 환경 변수는 true와 false만 받아 오타로 NFT 준비가 켜지지 않게 한다. */
function enabledValue(): boolean {
  const source = process.env.SEASON_NFT_ENABLED;
  if (source === undefined) return false;
  if (source === 'true') return true;
  if (source === 'false') return false;
  throw new Error('SEASON_NFT_ENABLED must be true or false.');
}

function optionalAbsolutePath(name: string): string | undefined {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return undefined;
  if (!path.isAbsolute(source))
    throw new Error(`${name} must be an absolute path.`);
  return source;
}

function optionalEndpoint(name: string): string | undefined {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return undefined;
  const parsed = new URL(source);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(`${name} must use http or https.`);
  return parsed.toString().replace(/\/$/, '');
}

function integerSetting(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return defaultValue;
  if (!/^[0-9]+$/.test(source))
    throw new Error(`${name} must be a decimal integer.`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}

function decimalBigIntSetting(name: string, defaultValue: bigint): bigint {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return defaultValue;
  if (!/^[0-9]+$/.test(source))
    throw new Error(`${name} must be a non-negative decimal integer.`);
  return BigInt(source);
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function validatePrivateDirectory(name: string, directory: string): string {
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0
  )
    throw new Error(`${name} must be a private non-symlink directory.`);
  return realpathSync(directory);
}

function validateServiceKey(filePath: string): string {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0)
    throw new Error(
      'SOLANA_SERVICE_KEYPAIR_PATH must be a private non-symlink file.',
    );
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error(
      'SOLANA_SERVICE_KEYPAIR_PATH must contain a 64-byte Ed25519 secret.',
    );
  }
  return realpathSync(filePath);
}

export default registerAs('seasonNft', (): SeasonNftConfig => {
  const enabled = enabledValue();
  const source = process.env.SOLANA_NETWORK;
  if (source !== undefined && source !== 'devnet' && source !== 'mainnet-beta')
    throw new Error('SOLANA_NETWORK must be devnet or mainnet-beta.');
  // 비활성 환경은 network 없이 시작할 수 있지만, 활성화 시 서버가 환경을 반드시 고정한다.
  if (enabled && source === undefined)
    throw new Error(
      'SOLANA_NETWORK is required when SEASON_NFT_ENABLED is true.',
    );
  const rpcUrl = optionalEndpoint('SOLANA_RPC_URL');
  const serviceKeypairPath = optionalAbsolutePath(
    'SOLANA_SERVICE_KEYPAIR_PATH',
  );
  const storageUploadUrl = optionalEndpoint('NFT_STORAGE_UPLOAD_URL');
  const storagePaymentUrl = optionalEndpoint('NFT_STORAGE_PAYMENT_URL');
  const storageGatewayUrl = optionalEndpoint('NFT_STORAGE_GATEWAY_URL');
  const uploadWorkDir = optionalAbsolutePath('NFT_UPLOAD_WORK_DIR');
  const preparationKeyDir = optionalAbsolutePath('NFT_PREPARATION_KEY_DIR');
  const rpcReadRps = integerSetting('NFT_RPC_READ_RPS', 5, 1, 5);
  const rpcSendIntervalMs = integerSetting(
    'NFT_RPC_SEND_INTERVAL_MS',
    1200,
    1200,
  );
  const priorityFeeMaxLamports = decimalBigIntSetting(
    'NFT_PRIORITY_FEE_MAX_LAMPORTS',
    0n,
  );

  if (enabled) {
    const required = [
      ['SOLANA_RPC_URL', rpcUrl],
      ['SOLANA_SERVICE_KEYPAIR_PATH', serviceKeypairPath],
      ['NFT_STORAGE_UPLOAD_URL', storageUploadUrl],
      ['NFT_STORAGE_PAYMENT_URL', storagePaymentUrl],
      ['NFT_STORAGE_GATEWAY_URL', storageGatewayUrl],
      ['NFT_UPLOAD_WORK_DIR', uploadWorkDir],
      ['NFT_PREPARATION_KEY_DIR', preparationKeyDir],
    ] as const;
    const missing = required.find(([, value]) => value === undefined);
    if (missing)
      throw new Error(
        `${missing[0]} is required when SEASON_NFT_ENABLED is true.`,
      );
    if (process.env.CANVAS_SNAPSHOT_ENABLED !== 'true')
      throw new Error(
        'CANVAS_SNAPSHOT_ENABLED must be true when SEASON_NFT_ENABLED is true.',
      );
    const snapshotRoot = optionalAbsolutePath('CANVAS_SNAPSHOT_STORAGE_ROOT');
    if (!snapshotRoot)
      throw new Error(
        'CANVAS_SNAPSHOT_STORAGE_ROOT is required when SEASON_NFT_ENABLED is true.',
      );
    const privateKey = validateServiceKey(serviceKeypairPath!);
    const uploadRoot = validatePrivateDirectory(
      'NFT_UPLOAD_WORK_DIR',
      uploadWorkDir!,
    );
    const preparationRoot = validatePrivateDirectory(
      'NFT_PREPARATION_KEY_DIR',
      preparationKeyDir!,
    );
    const publicSnapshots = path.join(realpathSync(snapshotRoot), 'snapshots');
    if (
      [privateKey, uploadRoot, preparationRoot].some((candidate) =>
        containsPath(publicSnapshots, candidate),
      )
    ) {
      throw new Error(
        'NFT private files and work directories must be outside the public snapshot subtree.',
      );
    }
    // 공개 media 작업 경로 아래 secret key를 두면 정적 서빙 설정 변경 시 키가 노출될 수 있다.
    if (
      containsPath(uploadRoot, preparationRoot) ||
      containsPath(preparationRoot, uploadRoot)
    ) {
      throw new Error(
        'NFT_PREPARATION_KEY_DIR and NFT_UPLOAD_WORK_DIR must be separate paths.',
      );
    }
  }

  return {
    enabled,
    network: source ?? null,
    rpcUrl,
    serviceKeypairPath,
    storageUploadUrl,
    storagePaymentUrl,
    storageGatewayUrl,
    uploadWorkDir,
    preparationKeyDir,
    rpcReadRps,
    rpcSendIntervalMs,
    priorityFeeMaxLamports,
  };
});
