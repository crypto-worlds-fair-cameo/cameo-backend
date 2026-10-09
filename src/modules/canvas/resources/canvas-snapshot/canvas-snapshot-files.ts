import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import type {
  CanvasSnapshotFileResult,
  CanvasSnapshotRecord,
} from './canvas-snapshot';

export const MAX_SNAPSHOT_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_CONTINUATION_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_CONTINUATION_ENTRIES = 10_000;
const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type ContinuationFile = {
  schemaVersion?: unknown;
  snapshotId?: unknown;
  canvasKey?: unknown;
  throughSequence?: unknown;
  rendererVersion?: unknown;
  strokes?: unknown;
};

/** 디스크 파일 저장소는 임시 파일 생성부터 immutable 디렉터리 공개까지 한 파일 시스템에서 처리한다. */
@Injectable()
export class CanvasSnapshotFiles {
  private initializedRoot?: string;
  private initialization?: Promise<void>;
  private usageBytes?: bigint;
  private pendingWriteBytes = 0n;

  constructor(private readonly config: ConfigService<AllConfigType>) {}

  /** 활성화된 저장 루트와 서비스 소유 디렉터리를 준비하고 실제 루트 경로를 고정한다. */
  async initialize(): Promise<void> {
    if (!this.enabled) return;
    if (this.initialization) return this.initialization;
    if (this.initializedRoot) return;
    if (!this.initialization) {
      this.initialization = this.initializeEnabled()
        .catch((error: unknown) => {
          this.initializedRoot = undefined;
          this.usageBytes = undefined;
          throw error;
        })
        .finally(() => {
          this.initialization = undefined;
        });
    }
    return this.initialization;
  }

  /** 동시 초기화 호출이 같은 디렉터리·용량 검증 작업을 공유하도록 실제 준비를 한 번 수행한다. */
  private async initializeEnabled(): Promise<void> {
    const root = this.storageRoot;
    await fs.mkdir(root, { recursive: true });
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory())
      throw new Error('Canvas snapshot storage root is not a directory.');
    this.initializedRoot = await fs.realpath(root);
    const serviceDirectories = [
      path.join(this.initializedRoot, 'snapshots', 'main'),
      path.join(this.initializedRoot, 'snapshots', 'seasons'),
      path.join(this.initializedRoot, '.tmp', 'snapshots'),
    ];
    await Promise.all([
      fs.mkdir(serviceDirectories[0], {
        recursive: true,
      }),
      fs.mkdir(serviceDirectories[1], {
        recursive: true,
      }),
      fs.mkdir(serviceDirectories[2], {
        recursive: true,
      }),
    ]);
    // 기존 하위 symlink가 외부 디스크를 가리키면 파일 생성과 정리를 시작하지 않는다.
    await Promise.all(
      serviceDirectories.map((directory) =>
        this.assertExistingDirectoryInsideRoot(directory),
      ),
    );
    // 시작 시 기존 확정·임시 파일을 한 번 계산하고 현재 파일 시스템 여유도 확인한다.
    await this.refreshUsage();
  }

  /** DB 메타데이터와 두 파일의 존재·크기를 검사하고 감사 시 SHA-256까지 스트리밍 비교한다. */
  async validate(
    record: CanvasSnapshotRecord,
    hash: boolean,
  ): Promise<boolean> {
    await this.requireInitialized();
    try {
      const image = await this.validateStoredFile(
        record.imageKey,
        record.imageBytes,
        MAX_SNAPSHOT_IMAGE_BYTES,
        hash ? record.imageSha256 : undefined,
      );
      if (!image) return false;
      return this.validateStoredFile(
        record.continuationKey,
        record.continuationBytes,
        MAX_SNAPSHOT_CONTINUATION_BYTES,
        hash ? record.continuationSha256 : undefined,
      );
    } catch (error: unknown) {
      // 파일이 사라진 경우만 손상 후보로 반환하고 권한·I/O 장애는 호출자가 운영 오류로 다룬다.
      if (this.errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /** 주기 순회 시작 시 외부에서 추가된 파일까지 포함해 디스크 사용량 캐시를 다시 계산한다. */
  async refreshCapacity(): Promise<void> {
    await this.requireInitialized();
    await this.refreshUsage();
  }

  /** 검증한 PNG와 상태 JSON을 임시 디렉터리에 쓴 뒤 같은 볼륨의 최종 경로로 원자적으로 이동한다. */
  async publish(
    target: CanvasTarget,
    id: string,
    throughSequence: string,
    rendererVersion: string,
    image: Buffer,
    continuation: Buffer,
    capturedAt: Date,
  ): Promise<CanvasSnapshotFileResult> {
    await this.requireInitialized();
    this.assertIdentity(
      target,
      id,
      throughSequence,
      rendererVersion,
      capturedAt,
    );
    this.assertPng(image, target);
    this.assertContinuation(
      continuation,
      target,
      id,
      throughSequence,
      rendererVersion,
    );
    const directoryKey = this.directoryKey(target, id);
    const imageKey = `${directoryKey}/image.png`;
    const continuationKey = `${directoryKey}/continuation.json`;
    const imageSha256 = this.bufferHash(image);
    const continuationSha256 = this.bufferHash(continuation);
    const result: CanvasSnapshotFileResult = {
      imageKey,
      continuationKey,
      imageBytes: image.byteLength,
      continuationBytes: continuation.byteLength,
      imageSha256,
      continuationSha256,
      continuationSchemaVersion: 1,
    };

    const finalDirectory = this.resolveKey(directoryKey);
    const finalParent = path.dirname(finalDirectory);
    await fs.mkdir(finalParent, { recursive: true });
    await this.assertExistingDirectoryInsideRoot(finalParent);

    // DB 응답 유실 뒤 같은 snapshotId를 재시도하면 기존 immutable 파일이 정확히 같을 때만 재사용한다.
    if (await this.pathExists(finalDirectory)) {
      const matches = await this.matchesPublishedFiles(result);
      if (!matches)
        throw new Error(
          'Canvas snapshot directory already contains different files.',
        );
      return result;
    }

    // 새 시도만 캐시 예산과 실제 여유 공간을 예약한다. 실패 예약은 다음 주기 재계산까지 보수적으로 유지한다.
    const reservedBytes = image.byteLength + continuation.byteLength;
    await this.reserveCapacity(reservedBytes);
    try {
      const temporaryDirectory = this.resolveTemporary(id);
      await fs.mkdir(temporaryDirectory, { recursive: false });
      try {
        await Promise.all([
          this.writeAndSync(path.join(temporaryDirectory, 'image.png'), image),
          this.writeAndSync(
            path.join(temporaryDirectory, 'continuation.json'),
            continuation,
          ),
        ]);
        await this.syncDirectory(temporaryDirectory);
        // rename은 동일 저장 루트 안에서만 수행해 두 파일이 함께 보이도록 한다.
        await fs.rename(temporaryDirectory, finalDirectory);
        await this.syncDirectory(finalParent);
        return result;
      } catch (error: unknown) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      this.pendingWriteBytes -= BigInt(reservedBytes);
    }
  }

  /** 상대 key를 설정한 공개 URL의 경로 접두사 뒤에 결합한다. */
  publicUrl(key: string): string {
    if (
      !/^snapshots\/(main|seasons)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(image\.png|continuation\.json)$/.test(
        key,
      )
    )
      throw new Error('Canvas snapshot public key is invalid.');
    const base = this.config.get('canvasSnapshot.publicBaseUrl', {
      infer: true,
    });
    if (!base) throw new Error('Canvas snapshot public base url is missing.');
    return `${base.replace(/\/+$/, '')}/${key}`;
  }

  /** 24시간이 지난 임시·미참조 확정 디렉터리만 DB 참조 확인 후 제거한다. */
  async cleanup(
    isReferenced: (directoryKey: string) => Promise<boolean>,
    activeId?: string,
  ): Promise<void> {
    await this.requireInitialized();
    const cutoff = Date.now() - ORPHAN_RETENTION_MS;
    const temporaryRoot = this.resolveKey('.tmp/snapshots');
    for (const entry of await fs.readdir(temporaryRoot, {
      withFileTypes: true,
    })) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name === activeId
      )
        continue;
      const directory = path.join(temporaryRoot, entry.name);
      const stat = await fs.stat(directory);
      if (stat.mtimeMs <= cutoff)
        await fs.rm(directory, { recursive: true, force: true });
    }

    for (const scope of ['main', 'seasons'] as const) {
      const scopeRoot = this.resolveKey(`snapshots/${scope}`);
      for (const canvasEntry of await fs.readdir(scopeRoot, {
        withFileTypes: true,
      })) {
        if (!canvasEntry.isDirectory() || canvasEntry.isSymbolicLink())
          continue;
        const canvasDirectory = path.join(scopeRoot, canvasEntry.name);
        for (const snapshotEntry of await fs.readdir(canvasDirectory, {
          withFileTypes: true,
        })) {
          if (
            !snapshotEntry.isDirectory() ||
            snapshotEntry.isSymbolicLink() ||
            snapshotEntry.name === activeId
          )
            continue;
          const directory = path.join(canvasDirectory, snapshotEntry.name);
          const stat = await fs.stat(directory);
          if (stat.mtimeMs > cutoff) continue;
          const key = `snapshots/${scope}/${canvasEntry.name}/${snapshotEntry.name}`;
          // DB 조회 오류가 나면 callback이 throw하며 파일을 그대로 보존한다.
          if (!(await isReferenced(key)))
            await fs.rm(directory, { recursive: true, force: true });
        }
      }
    }
    // 삭제량은 다음 주기 refreshCapacity에서 반영해 계산 실패도 예산을 과소평가하지 않게 한다.
  }

  private get enabled(): boolean {
    return this.config.get('canvasSnapshot.enabled', { infer: true }) === true;
  }

  private get storageRoot(): string {
    const root = this.config.get('canvasSnapshot.storageRoot', { infer: true });
    if (!root) throw new Error('Canvas snapshot storage root is missing.');
    return root;
  }

  /** 활성화되지 않은 기능은 디렉터리를 만들지 않고 저장 기능 호출을 거절한다. */
  private async requireInitialized(): Promise<void> {
    if (!this.enabled) throw new Error('Canvas snapshot storage is disabled.');
    await this.initialize();
  }

  private resolveKey(key: string): string {
    if (!this.initializedRoot)
      throw new Error('Canvas snapshot storage is not initialized.');
    this.assertRelativeKey(key);
    const resolved = path.resolve(this.initializedRoot, key);
    if (
      resolved !== this.initializedRoot &&
      !resolved.startsWith(`${this.initializedRoot}${path.sep}`)
    )
      throw new Error('Canvas snapshot key escaped storage root.');
    return resolved;
  }

  private resolveTemporary(id: string): string {
    return this.resolveKey(`.tmp/snapshots/${id}`);
  }

  private assertRelativeKey(key: string): void {
    if (
      key.length === 0 ||
      path.isAbsolute(key) ||
      key.includes('\\') ||
      key.split('/').includes('..')
    )
      throw new Error('Canvas snapshot key is invalid.');
  }

  private directoryKey(target: CanvasTarget, id: string): string {
    const scope = target.kind === 'main' ? 'main' : 'seasons';
    return `snapshots/${scope}/${target.id.toLowerCase()}/${id.toLowerCase()}`;
  }

  private assertIdentity(
    target: CanvasTarget,
    id: string,
    throughSequence: string,
    rendererVersion: string,
    capturedAt: Date,
  ): void {
    if (!UUID_PATTERN.test(target.id) || !UUID_PATTERN.test(id))
      throw new Error('Canvas snapshot identifier is invalid.');
    const keyMatches =
      (target.kind === 'main' && target.key === 'main') ||
      (target.kind === 'season' &&
        target.key === `season:${target.id.toLowerCase()}`);
    if (!keyMatches)
      throw new Error('Canvas snapshot target identity is invalid.');
    if (!/^(0|[1-9][0-9]*)$/.test(throughSequence))
      throw new Error('Canvas snapshot boundary is invalid.');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(rendererVersion))
      throw new Error('Canvas snapshot renderer version is invalid.');
    if (!Number.isFinite(capturedAt.getTime()))
      throw new Error('Canvas snapshot capture time is invalid.');
  }

  private assertPng(image: Buffer, target: CanvasTarget): void {
    if (image.byteLength === 0 || image.byteLength > MAX_SNAPSHOT_IMAGE_BYTES)
      throw new Error('Canvas snapshot PNG exceeds its byte limit.');
    if (
      image.byteLength < 24 ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      image.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new Error('Canvas snapshot image is not a PNG.');
    if (
      image.readUInt32BE(16) !== target.width ||
      image.readUInt32BE(20) !== target.height
    )
      throw new Error(
        'Canvas snapshot PNG dimensions do not match its canvas.',
      );
  }

  private assertContinuation(
    bytes: Buffer,
    target: CanvasTarget,
    id: string,
    throughSequence: string,
    rendererVersion: string,
  ): void {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_SNAPSHOT_CONTINUATION_BYTES
    )
      throw new Error('Canvas snapshot continuation exceeds its byte limit.');
    let parsed: ContinuationFile;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as ContinuationFile;
    } catch {
      throw new Error('Canvas snapshot continuation is not valid JSON.');
    }
    if (
      !this.record(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.snapshotId !== id ||
      parsed.canvasKey !== target.key ||
      parsed.throughSequence !== throughSequence ||
      parsed.rendererVersion !== rendererVersion ||
      !Array.isArray(parsed.strokes) ||
      parsed.strokes.length > MAX_SNAPSHOT_CONTINUATION_ENTRIES
    )
      throw new Error('Canvas snapshot continuation metadata is invalid.');

    const identities = new Set<string>();
    for (const stroke of parsed.strokes) {
      if (!this.validContinuationStroke(stroke, target))
        throw new Error('Canvas snapshot continuation stroke is invalid.');
      const identity = `${stroke.userId}:${stroke.clientStrokeId}`;
      if (identities.has(identity))
        throw new Error(
          'Canvas snapshot continuation contains a duplicate stroke.',
        );
      identities.add(identity);
    }
  }

  private validContinuationStroke(
    value: unknown,
    target: CanvasTarget,
  ): value is {
    userId: string;
    clientStrokeId: string;
  } {
    if (!this.record(value) || !UUID_PATTERN.test(String(value.userId)))
      return false;
    if (!UUID_PATTERN.test(String(value.clientStrokeId))) return false;
    if (
      !Number.isSafeInteger(value.lastChunkIndex) ||
      Number(value.lastChunkIndex) < 0 ||
      Number(value.lastChunkIndex) > 1_000_000
    )
      return false;
    if (!this.record(value.brush) || !this.validBrush(value.brush))
      return false;
    if (!this.record(value.state)) return false;
    if (
      !Number.isFinite(value.state.progress) ||
      Number(value.state.progress) < 0
    )
      return false;
    if (
      !Number.isSafeInteger(value.state.sampleIndex) ||
      Number(value.state.sampleIndex) < 0
    )
      return false;
    const point = value.state.lastPoint;
    if (point === null) return true;
    if (!this.record(point)) return false;
    if (
      !this.inRange(point.x, 0, target.width) ||
      Number(point.x) >= target.width
    )
      return false;
    if (
      !this.inRange(point.y, 0, target.height) ||
      Number(point.y) >= target.height
    )
      return false;
    return point.t === undefined || this.inRange(point.t, 0, 3_600_000);
  }

  private validBrush(value: Record<string, unknown>): boolean {
    if (!['round', 'flat', 'airbrush'].includes(String(value.type)))
      return false;
    if (value.version !== 1 || !this.inRange(value.size, 1, 200)) return false;
    if (!this.inRange(value.opacity, 0.01, 1)) return false;
    if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color))
      return false;
    if (value.type === 'flat' && !this.inRange(value.angle, 0, 360))
      return false;
    if (
      value.type === 'airbrush' &&
      (!this.inRange(value.seed, 0, 4_294_967_295) ||
        !Number.isInteger(value.seed))
    )
      return false;
    return true;
  }

  /** 새 파일 바이트를 동기적으로 예약한 뒤 statfs로 실제 여유 공간을 확인한다. */
  private async reserveCapacity(incomingBytes: number): Promise<void> {
    if (this.usageBytes === undefined)
      throw new Error('Canvas snapshot disk usage is not initialized.');
    const budget = this.config.get('canvasSnapshot.diskBudgetBytes', {
      infer: true,
    });
    if (budget === undefined)
      throw new Error('Canvas snapshot disk limits are missing.');
    const reserved = BigInt(incomingBytes);
    if (this.usageBytes + reserved > BigInt(budget))
      throw new Error('Canvas snapshot disk budget would be exceeded.');
    // await 전에 예약해 동시에 들어온 publish도 같은 캐시 예산을 중복 사용하지 못하게 한다.
    this.usageBytes += reserved;
    this.pendingWriteBytes += reserved;
    try {
      await this.assertFilesystemCapacity(this.pendingWriteBytes);
    } catch (error: unknown) {
      this.pendingWriteBytes -= reserved;
      throw error;
    }
  }

  /** statfs는 트리 순회 없이 새 파일을 쓴 뒤에도 최소 여유가 남는지만 검사한다. */
  private async assertFilesystemCapacity(
    incomingBytes: bigint | number,
  ): Promise<void> {
    const minimumFree = this.config.get('canvasSnapshot.minFreeBytes', {
      infer: true,
    });
    if (minimumFree === undefined)
      throw new Error('Canvas snapshot disk limits are missing.');
    const filesystem = await fs.statfs(this.initializedRoot!, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    if (available - BigInt(incomingBytes) < BigInt(minimumFree))
      throw new Error('Canvas snapshot filesystem free space is too low.');
  }

  /** 확정·임시 디렉터리를 주기당 한 번 순회해 외부 파일과 이전 보수 예약을 실제 사용량으로 교체한다. */
  private async refreshUsage(): Promise<void> {
    if (this.pendingWriteBytes !== 0n)
      throw new Error(
        'Canvas snapshot disk usage cannot refresh during a write.',
      );
    const root = this.initializedRoot!;
    const [publishedBytes, temporaryBytes] = await Promise.all([
      this.directoryBytes(path.join(root, 'snapshots')),
      this.directoryBytes(path.join(root, '.tmp', 'snapshots')),
    ]);
    const usage = publishedBytes + temporaryBytes;
    const budget = this.config.get('canvasSnapshot.diskBudgetBytes', {
      infer: true,
    });
    if (budget === undefined)
      throw new Error('Canvas snapshot disk limits are missing.');
    // 초과 사용량도 기록한다. 기존 파일 조회·orphan 정리는 허용하고 새 쓰기 예약만 거절한다.
    this.usageBytes = usage;
  }

  private async directoryBytes(directory: string): Promise<bigint> {
    let total = 0n;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) total += await this.directoryBytes(child);
      else if (entry.isFile())
        total += (await fs.stat(child, { bigint: true })).size;
    }
    return total;
  }

  private async validateStoredFile(
    key: string,
    expectedBytes: string,
    maximumBytes: number,
    expectedHash?: string,
  ): Promise<boolean> {
    const file = this.resolveKey(key);
    const realFile = await fs.realpath(file);
    this.assertInsideRoot(realFile);
    const stat = await fs.stat(realFile, { bigint: true });
    const expected = BigInt(expectedBytes);
    if (
      expected <= 0n ||
      expected > BigInt(maximumBytes) ||
      !stat.isFile() ||
      stat.size !== expected
    )
      return false;
    if (expectedHash && (await this.fileHash(realFile)) !== expectedHash)
      return false;
    return true;
  }

  private async matchesPublishedFiles(
    expected: CanvasSnapshotFileResult,
  ): Promise<boolean> {
    const image = this.resolveKey(expected.imageKey);
    const continuation = this.resolveKey(expected.continuationKey);
    try {
      const [realImage, realContinuation] = await Promise.all([
        fs.realpath(image),
        fs.realpath(continuation),
      ]);
      this.assertInsideRoot(realImage);
      this.assertInsideRoot(realContinuation);
      const [imageStat, continuationStat, imageHash, continuationHash] =
        await Promise.all([
          fs.stat(realImage, { bigint: true }),
          fs.stat(realContinuation, { bigint: true }),
          this.fileHash(realImage),
          this.fileHash(realContinuation),
        ]);
      return (
        imageStat.isFile() &&
        continuationStat.isFile() &&
        imageStat.size === BigInt(expected.imageBytes) &&
        continuationStat.size === BigInt(expected.continuationBytes) &&
        imageHash === expected.imageSha256 &&
        continuationHash === expected.continuationSha256
      );
    } catch (error: unknown) {
      if (this.errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async writeAndSync(file: string, bytes: Buffer): Promise<void> {
    const handle = await fs.open(file, 'wx', 0o640);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async assertExistingDirectoryInsideRoot(
    directory: string,
  ): Promise<void> {
    const realDirectory = await fs.realpath(directory);
    this.assertInsideRoot(realDirectory);
  }

  private assertInsideRoot(value: string): void {
    const root = this.initializedRoot!;
    if (value !== root && !value.startsWith(`${root}${path.sep}`))
      throw new Error('Canvas snapshot path escaped storage root.');
  }

  private async pathExists(value: string): Promise<boolean> {
    try {
      await fs.lstat(value);
      return true;
    } catch (error: unknown) {
      if (this.errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private bufferHash(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async fileHash(file: string): Promise<string> {
    const hash = createHash('sha256');
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }

  private errorCode(error: unknown): string | undefined {
    return this.record(error) && typeof error.code === 'string'
      ? error.code
      : undefined;
  }

  private record(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private inRange(value: unknown, minimum: number, maximum: number): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= minimum &&
      value <= maximum
    );
  }
}
