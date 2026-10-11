export type NftRpcJobKind =
  'USER_SEND' | 'USER_CHECK' | 'USER_BUILD' | 'RELEASE_PREPARE';

export type NftRpcJob<T> = Readonly<{
  kind: NftRpcJobKind;
  rpcType?: 'READ' | 'SEND';
  run: (signal: AbortSignal) => Promise<T>;
}>;

export type NftSchedulerClock = Readonly<{
  now(): number;
  sleep(delayMs: number): Promise<void>;
}>;

export type NftStorageIo = Readonly<{
  signal: AbortSignal;
  assertMayStart: () => void;
}>;

type QueuedJob<T = any> = {
  job: NftRpcJob<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const PRIORITY: Readonly<Record<NftRpcJobKind, number>> = {
  USER_SEND: 0,
  USER_CHECK: 1,
  USER_BUILD: 2,
  RELEASE_PREPARE: 3,
};

const SYSTEM_CLOCK: NftSchedulerClock = {
  // performance.now는 wall-clock 보정과 무관한 monotonic 값이라 rolling window가 뒤로 가지 않는다.
  now: () => performance.now(),
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

/** 체인 RPC의 rolling budget과 우선순위를 소유하고 storage 작업은 별도 직렬 lane에서 실행한다. */
export class NftRpcScheduler {
  private readonly chainQueue: QueuedJob[] = [];
  private readonly starts: number[] = [];
  private chainRunning = false;
  private chainKickPending = false;
  private storageTail: Promise<unknown> = Promise.resolve();
  private consecutiveUserJobs = 0;
  private nextSendAt = Number.NEGATIVE_INFINITY;
  private accepting = true;
  private activeChainController: AbortController | null = null;
  private activeStorageController: AbortController | null = null;

  constructor(
    private readonly settings: Readonly<{
      readRps: number;
      sendIntervalMs: number;
      rpcTimeoutMs?: number;
    }>,
    private readonly clock: NftSchedulerClock = SYSTEM_CLOCK,
    private readonly mayStart: () => boolean = () => true,
  ) {}

  /** kind만으로 정렬한 callback을 shared rolling limiter와 단일 chain lane에서 실행한다. */
  enqueue<T>(job: NftRpcJob<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new Error('NFT RPC scheduler is stopped.'));
    const promise = new Promise<T>((resolve, reject) => {
      this.chainQueue.push({ job, resolve, reject });
    });
    this.scheduleChainDrain();
    return promise;
  }

  /** 업로드와 gateway 작업은 별도 concurrency 1 lane에 연결해 chain lane 대기를 만들지 않는다. */
  enqueueStorage<T>(run: (io: NftStorageIo) => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new Error('NFT RPC scheduler is stopped.'));
    const guardedRun = async () => {
      // leader loss 뒤 아직 시작하지 않은 upload/gateway callback도 chain callback과 같은 기준으로 막는다.
      if (!this.accepting || !this.mayStart())
        throw new Error(
          'NFT worker is not the active leader or scheduler is stopped.',
        );
      const controller = new AbortController();
      this.activeStorageController = controller;
      try {
        return await run({
          signal: controller.signal,
          assertMayStart: () => {
            if (!this.accepting || !this.mayStart())
              throw new Error('NFT worker is not the active leader.');
            controller.signal.throwIfAborted();
          },
        });
      } finally {
        if (this.activeStorageController === controller)
          this.activeStorageController = null;
      }
    };
    const result = this.storageTail.then(guardedRun, guardedRun);
    this.storageTail = result.catch(() => undefined);
    return result;
  }

  /** leader loss나 shutdown 이후 queued callback이 새 외부 I/O를 시작하지 못하게 한다. */
  stop(): void {
    this.accepting = false;
    const error = new Error('NFT RPC scheduler stopped before job start.');
    for (const queued of this.chainQueue.splice(0)) queued.reject(error);
  }

  /** shutdown은 queued start를 막은 뒤 이미 시작한 chain/storage bookkeeping의 종료를 기다린다. */
  async drain(): Promise<void> {
    while (this.chainRunning || this.chainQueue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await this.storageTail;
  }

  /** shutdown deadline 뒤 진행 중 transport signal을 중단해 후속 gateway/DB 단계를 시작하지 않는다. */
  abortActive(): void {
    this.activeChainController?.abort();
    this.activeStorageController?.abort();
  }

  private scheduleChainDrain(): void {
    if (this.chainRunning || this.chainKickPending) return;
    this.chainKickPending = true;
    queueMicrotask(() => {
      this.chainKickPending = false;
      void this.drainChain();
    });
  }

  private async drainChain(): Promise<void> {
    if (this.chainRunning) return;
    this.chainRunning = true;
    try {
      while (this.accepting && this.chainQueue.length > 0) {
        const queued = this.takeNext();
        try {
          await this.waitForBudget(queued.job);
          // 대기 중 leader generation을 잃으면 callback 자체를 시작하지 않는다.
          if (!this.accepting || !this.mayStart())
            throw new Error('NFT worker is not the active leader.');
          const startedAt = this.clock.now();
          this.recordStart(queued.job, startedAt);
          const controller = new AbortController();
          this.activeChainController = controller;
          try {
            queued.resolve(
              await queued.job.run(
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(this.settings.rpcTimeoutMs ?? 10_000),
                ]),
              ),
            );
          } finally {
            if (this.activeChainController === controller)
              this.activeChainController = null;
          }
        } catch (error: unknown) {
          queued.reject(error);
        }
      }
    } finally {
      this.chainRunning = false;
      if (this.accepting && this.chainQueue.length > 0)
        this.scheduleChainDrain();
    }
  }

  private takeNext(): QueuedJob {
    const releaseIndex = this.chainQueue.findIndex(
      ({ job }) => job.kind === 'RELEASE_PREPARE',
    );
    // 연속 사용자 작업 10개 뒤 due release가 있으면 정확히 한 번 양보한다.
    if (this.consecutiveUserJobs >= 10 && releaseIndex >= 0) {
      this.consecutiveUserJobs = 0;
      return this.chainQueue.splice(releaseIndex, 1)[0];
    }
    let selected = 0;
    for (let index = 1; index < this.chainQueue.length; index += 1) {
      if (
        PRIORITY[this.chainQueue[index].job.kind] <
        PRIORITY[this.chainQueue[selected].job.kind]
      ) {
        selected = index;
      }
    }
    const queued = this.chainQueue.splice(selected, 1)[0];
    if (queued.job.kind === 'RELEASE_PREPARE') this.consecutiveUserJobs = 0;
    else this.consecutiveUserJobs += 1;
    return queued;
  }

  private async waitForBudget(job: NftRpcJob<unknown>): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.pruneStarts(now);
      const rollingWait =
        this.starts.length < this.settings.readRps
          ? 0
          : Math.max(0, this.starts[0] + 1000 - now);
      const sendWait = this.isSend(job)
        ? Math.max(0, this.nextSendAt - now)
        : 0;
      const delay = Math.max(rollingWait, sendWait);
      if (delay === 0) return;
      await this.clock.sleep(delay);
    }
  }

  private pruneStarts(now: number): void {
    while (this.starts[0] !== undefined && this.starts[0] <= now - 1000)
      this.starts.shift();
  }

  private recordStart(job: NftRpcJob<unknown>, startedAt: number): void {
    this.starts.push(startedAt);
    if (this.isSend(job))
      this.nextSendAt = startedAt + this.settings.sendIntervalMs;
  }

  private isSend(job: NftRpcJob<unknown>): boolean {
    return job.kind === 'USER_SEND' || job.rpcType === 'SEND';
  }
}
