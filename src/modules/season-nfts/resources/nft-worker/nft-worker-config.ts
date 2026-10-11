import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import type { SeasonNftNetwork } from '../season-nft/season-nft';

export type NftWorkerRuntimeConfig = Readonly<{
  enabled: boolean;
  network: SeasonNftNetwork | null;
  advisoryNetworkKey: 1 | 2 | null;
  rpcReadRps: number;
  rpcSendIntervalMs: number;
  jobScanIntervalMs: 1000;
  seasonScanIntervalMs: 60_000;
  rpcTimeoutMs: 10_000;
  uploadTimeoutMs: 120_000;
  gatewayTimeoutMs: 30_000;
  shutdownTimeoutMs: 15_000;
}>;

/** validated config factory 값을 worker가 사용하는 network lock과 고정 timeout 계약으로 변환한다. */
@Injectable()
export class NftWorkerConfig {
  constructor(private readonly config: ConfigService<AllConfigType>) {}

  read(): NftWorkerRuntimeConfig {
    const enabled =
      this.config.get('seasonNft.enabled', { infer: true }) ?? false;
    const network =
      this.config.get('seasonNft.network', { infer: true }) ?? null;
    const rpcReadRps =
      this.config.get('seasonNft.rpcReadRps', { infer: true }) ?? 5;
    const rpcSendIntervalMs =
      this.config.get('seasonNft.rpcSendIntervalMs', { infer: true }) ?? 1200;
    // disabled 환경은 network와 secret 없이도 worker I/O를 전혀 시작하지 않는다.
    if (!enabled)
      return {
        enabled,
        network,
        advisoryNetworkKey:
          network === null ? null : network === 'devnet' ? 1 : 2,
        rpcReadRps,
        rpcSendIntervalMs,
        jobScanIntervalMs: 1000,
        seasonScanIntervalMs: 60_000,
        rpcTimeoutMs: 10_000,
        uploadTimeoutMs: 120_000,
        gatewayTimeoutMs: 30_000,
        shutdownTimeoutMs: 15_000,
      };
    if (!network)
      throw new Error('seasonNft.network is required for the NFT worker.');
    return {
      enabled,
      network,
      advisoryNetworkKey: network === 'devnet' ? 1 : 2,
      rpcReadRps,
      rpcSendIntervalMs,
      jobScanIntervalMs: 1000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 15_000,
    };
  }
}
