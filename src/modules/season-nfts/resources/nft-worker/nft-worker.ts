import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { NftRpcScheduler } from './rpc-scheduler';
import { NftWorkerConfig } from './nft-worker-config';
import type { NftWorkerRuntimeConfig } from './nft-worker-config';

const ADVISORY_NAMESPACE = 20261009;

export abstract class NftWorkerQueue {
  abstract scan(scheduler: NftRpcScheduler): Promise<void>;
  scanCandidates?(scheduler: NftRpcScheduler): Promise<void>;
}

export abstract class NftWorkerStartup {
  abstract validate(scheduler: NftRpcScheduler): Promise<void>;
}

/** 하나의 dedicated PostgreSQL session에 advisory lock의 획득·손실·해제를 묶는다. */
export class NftLeaderSession {
  private client: PoolClient | null = null;
  private acquired = false;
  private closed = false;
  private lossReported = false;
  private lost = false;
  private acquireInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly networkKey: 1 | 2,
    private readonly onLoss: () => void,
  ) {}

  async acquire(): Promise<boolean> {
    if (this.client) return this.acquired;
    if (this.acquireInFlight) return this.acquireInFlight;
    this.closed = false;
    this.lossReported = false;
    this.lost = false;
    this.acquireInFlight = this.performAcquire().finally(() => {
      this.acquireInFlight = null;
    });
    return this.acquireInFlight;
  }

  private async performAcquire(): Promise<boolean> {
    const client = await this.pool.connect();
    // connect가 shutdown deadline 뒤 완료되어도 lock query를 새로 시작하지 않는다.
    if (this.closed || this.lost) {
      client.release(true);
      return false;
    }
    this.client = client as PoolClient;
    client.on('error', this.handleLoss);
    client.on('end', this.handleLoss);
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [ADVISORY_NAMESPACE, this.networkKey],
      );
      this.acquired = result.rows[0]?.acquired === true;
      // shutdown/loss during connect or query must not publish a new leader generation.
      if (this.closed || this.lost) {
        if (this.acquired && this.client === client) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock($1, $2) AS unlocked',
              [ADVISORY_NAMESPACE, this.networkKey],
            );
          } catch {
            // ended sessions already released the advisory lock.
          }
        }
        this.acquired = false;
        await this.releaseClient(this.lost);
        return false;
      }
      if (!this.acquired) await this.releaseClient();
      return this.acquired;
    } catch (error: unknown) {
      await this.releaseClient(true);
      throw error;
    }
  }

  /** 획득한 같은 session에서 unlock한 뒤 pool에 반환하며 이미 끊긴 session 오류는 숨긴다. */
  async close(): Promise<void> {
    if (this.closed && !this.client && !this.acquireInFlight) return;
    this.closed = true;
    // acquire owns the client until its lock query resolves, then observes closed and releases once.
    if (this.acquireInFlight) {
      await this.acquireInFlight.catch(() => false);
    }
    const client = this.client;
    const acquired = this.acquired;
    this.acquired = false;
    if (!client) return;
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2) AS unlocked', [
          ADVISORY_NAMESPACE,
          this.networkKey,
        ]);
      } catch {
        // session loss itself releases PostgreSQL advisory locks.
      }
    }
    await this.releaseClient(this.lost);
  }

  /** 종료 deadline을 넘긴 session을 즉시 pool에서 폐기하고 늦은 acquire 결과를 무효화한다. */
  discard(): void {
    this.closed = true;
    this.lost = true;
    this.acquired = false;
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeListener('error', this.handleLoss);
    client.removeListener('end', this.handleLoss);
    client.release(true);
  }

  private readonly handleLoss = (): void => {
    if (this.lossReported || this.closed) return;
    this.lossReported = true;
    this.lost = true;
    this.acquired = false;
    this.onLoss();
  };

  private async releaseClient(discard = false): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeListener('error', this.handleLoss);
    client.removeListener('end', this.handleLoss);
    client.release(discard);
  }
}

/** Nest lifecycle에서 leader generation을 소유하고 DB scan 결과만 scheduler callback으로 실행한다. */
@Injectable()
export class NftWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private runtime: NftWorkerRuntimeConfig;
  private leaderSession: NftLeaderSession | null = null;
  private scheduler: NftRpcScheduler | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private candidateScanTimer: NodeJS.Timeout | null = null;
  private reacquireTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private leader = false;
  private generation = 0;
  private activeScan: Promise<void> | null = null;
  private activeCandidateScan: Promise<void> | null = null;

  constructor(
    private readonly config: NftWorkerConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly queue: NftWorkerQueue,
    @Optional() private readonly startup?: NftWorkerStartup,
  ) {
    this.runtime = this.config.read();
  }

  async onApplicationBootstrap(): Promise<void> {
    this.runtime = this.config.read();
    // disabled boot는 dedicated connection, filesystem, RPC를 전혀 열지 않는다.
    if (!this.runtime.enabled) return;
    if (this.startup) {
      const startupScheduler = new NftRpcScheduler({
        readRps: this.runtime.rpcReadRps,
        sendIntervalMs: this.runtime.rpcSendIntervalMs,
        rpcTimeoutMs: this.runtime.rpcTimeoutMs,
      });
      try {
        // Endpoint identity is checked through the same limiter before PostgreSQL leadership begins.
        await this.startup.validate(startupScheduler);
      } finally {
        startupScheduler.stop();
        await startupScheduler.drain();
      }
    }
    await this.acquireLeadership();
    if (this.leader) await this.scanNow();
    if (this.leader) await this.scanCandidatesNow();
  }

  /** 운영 tick과 테스트가 같은 직렬 scan 경계를 사용하며 stale generation은 시작 전에 중단한다. */
  async scanNow(): Promise<void> {
    if (this.stopping || !this.leader || !this.scheduler) return;
    if (this.activeScan) return this.activeScan;
    const generation = this.generation;
    const scheduler = this.scheduler;
    this.activeScan = (async () => {
      if (!this.isActiveGeneration(generation)) return;
      await this.queue.scan(scheduler);
    })().finally(() => {
      this.activeScan = null;
    });
    return this.activeScan;
  }

  async scanCandidatesNow(): Promise<void> {
    if (this.stopping || !this.leader || !this.scheduler) return;
    if (this.activeCandidateScan) return this.activeCandidateScan;
    const generation = this.generation;
    const scheduler = this.scheduler;
    this.activeCandidateScan = (async () => {
      if (!this.isActiveGeneration(generation)) return;
      await this.queue.scanCandidates?.(scheduler);
    })().finally(() => {
      this.activeCandidateScan = null;
    });
    return this.activeCandidateScan;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const scheduler = this.scheduler;
    this.loseLeadership(false);
    if (this.reacquireTimer) clearTimeout(this.reacquireTimer);
    this.reacquireTimer = null;
    const session = this.leaderSession;
    this.leaderSession = null;
    const shutdownWork = Promise.allSettled([
      session?.close(),
      scheduler?.drain(),
      this.activeScan,
      this.activeCandidateScan,
    ]);
    let timeout: NodeJS.Timeout | undefined;
    // session 정리와 두 scan은 각각이 아니라 하나의 총 shutdown 예산을 공유한다.
    const completed = await Promise.race([
      shutdownWork.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          this.runtime.shutdownTimeoutMs,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      session?.discard();
      scheduler?.abortActive();
    }
  }

  private async acquireLeadership(): Promise<void> {
    if (
      this.stopping ||
      !this.runtime.enabled ||
      this.runtime.advisoryNetworkKey === null
    ) {
      return;
    }
    const session = new NftLeaderSession(
      this.pool,
      this.runtime.advisoryNetworkKey,
      () => this.handleSessionLoss(session),
    );
    this.leaderSession = session;
    try {
      if (!(await session.acquire())) {
        if (this.leaderSession === session) this.leaderSession = null;
        this.scheduleReacquire();
        return;
      }
      // shutdown or a newer session can win while connect/lock query is pending.
      if (this.stopping || this.leaderSession !== session) {
        await session.close();
        return;
      }
      this.generation += 1;
      const generation = this.generation;
      this.leader = true;
      this.scheduler = new NftRpcScheduler(
        {
          readRps: this.runtime.rpcReadRps,
          sendIntervalMs: this.runtime.rpcSendIntervalMs,
          rpcTimeoutMs: this.runtime.rpcTimeoutMs,
        },
        undefined,
        () => this.isActiveGeneration(generation),
      );
      this.scanTimer = setInterval(() => {
        void this.scanNow().catch(() => undefined);
      }, this.runtime.jobScanIntervalMs);
      this.candidateScanTimer = setInterval(() => {
        void this.scanCandidatesNow().catch(() => undefined);
      }, this.runtime.seasonScanIntervalMs);
    } catch {
      await session.close();
      if (this.leaderSession === session) this.leaderSession = null;
      this.scheduleReacquire();
    }
  }

  private loseLeadership(reacquire: boolean): void {
    this.leader = false;
    this.generation += 1;
    this.scheduler?.stop();
    this.scheduler = null;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.candidateScanTimer) clearInterval(this.candidateScanTimer);
    this.candidateScanTimer = null;
    if (reacquire) this.scheduleReacquire();
  }

  private handleSessionLoss(session: NftLeaderSession): void {
    // stale events from a replaced session cannot invalidate the current generation.
    if (this.leaderSession !== session) return;
    this.leaderSession = null;
    this.loseLeadership(false);
    void session.close().finally(() => this.scheduleReacquire());
  }

  private scheduleReacquire(): void {
    if (this.stopping || this.reacquireTimer) return;
    this.reacquireTimer = setTimeout(() => {
      this.reacquireTimer = null;
      void this.acquireLeadership();
    }, this.runtime.jobScanIntervalMs);
  }

  private isActiveGeneration(generation: number): boolean {
    return !this.stopping && this.leader && this.generation === generation;
  }
}
