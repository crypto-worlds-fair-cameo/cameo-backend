import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import { chromium, type BrowserServer } from 'playwright';
import { CanvasChunkRepository } from '../canvas-drawing/canvas-chunk.repository';
import type { CanvasTarget } from '../canvas-definition/canvas-target';

export const SNAPSHOT_RENDERER_VERSION = 'cameo-canvas-v1';
const runFile = promisify(execFile);
const MAX_RENDER_BYTES = 2 * 1024 ** 3;

/** UI 없는 고정 브러시 번들을 격리된 Chromium에서 재생하고 제한된 산출물만 돌려준다. */
@Injectable()
export class CanvasSnapshotRenderer {
  private script?: string;
  private server?: BrowserServer;
  private stopped = false;

  constructor(
    private readonly chunks: CanvasChunkRepository,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  /** 실행 경로와 무관하게 배포 패키지의 고정 산출물과 해시를 확인한다. */
  async initialize(): Promise<void> {
    const directory = path.resolve(
      __dirname,
      '../../../../..',
      'assets/canvas-capture',
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
    ) as {
      rendererVersion?: string;
      bundleSha256?: string;
      sourceRevision?: string;
    };
    const bytes = await fs.readFile(path.join(directory, 'renderer.js'));
    // 개발 중 산출물은 내용 해시로 검증하되 운영은 재현 가능한 commit SHA만 허용한다.
    if (
      this.config.get('app.nodeEnv', { infer: true }) === 'production' &&
      !/^[0-9a-f]{40}$/.test(manifest.sourceRevision ?? '')
    )
      throw new Error(
        'Production canvas capture artifact requires a clean source commit.',
      );
    if (
      manifest.rendererVersion !== SNAPSHOT_RENDERER_VERSION ||
      !manifest.sourceRevision ||
      manifest.bundleSha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('Canvas capture artifact is invalid.');
    this.script = bytes.toString('utf8');
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  }

  /** 고정된 DB 경계까지 페이지를 소비한다. timeout·메모리 초과 뒤에는 늦은 결과를 공개하지 않는다. */
  async render(
    target: CanvasTarget,
    throughSequence: string,
  ): Promise<{
    image: Buffer;
    strokes: unknown[];
    elapsedMs: number;
    peakBytes: number;
  }> {
    if (!this.script || this.stopped || this.server)
      throw new Error('Canvas renderer is unavailable.');
    const started = Date.now();
    const server = await chromium.launchServer({ headless: true });
    this.server = server;
    let timedOut = false;
    let overMemory = false;
    let checking = false;
    let peakBytes = 0;
    const timeout = setTimeout(() => {
      timedOut = true;
      void server.kill().catch(() => {});
    }, 300_000);
    const memory = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.memoryBytes(server.process().pid!)
        .then((bytes) => {
          peakBytes = Math.max(peakBytes, bytes);
          if (bytes > MAX_RENDER_BYTES) {
            overMemory = true;
            void server.kill().catch(() => {});
          }
        })
        .finally(() => {
          checking = false;
        })
        .catch(() => {});
    }, 1000);
    try {
      const browser = await chromium.connect(server.wsEndpoint());
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: this.script });
      await page.evaluate(({ width, height }) => {
        (
          window as unknown as {
            cameoCapture: { initialize(w: number, h: number): void };
          }
        ).cameoCapture.initialize(width, height);
      }, target);
      let cursor = '0';
      while (BigInt(cursor) < BigInt(throughSequence)) {
        if (this.stopped) throw new Error('Canvas capture was cancelled.');
        const previews = await this.chunks.page(
          target.id,
          cursor,
          throughSequence,
          50,
          'capture',
          target.key,
        );
        if (!previews.length)
          throw new Error('Canvas capture sequence is incomplete.');
        for (let i = 0; i < previews.length; i++) {
          if (BigInt(previews[i].sequence) !== BigInt(cursor) + BigInt(i + 1))
            throw new Error('Canvas capture sequence is incomplete.');
        }
        await page.evaluate((chunks) => {
          (
            window as unknown as {
              cameoCapture: { append(input: unknown[]): void };
            }
          ).cameoCapture.append(chunks);
        }, previews);
        cursor = previews.at(-1)!.sequence;
      }
      const output = await page.evaluate(async () => {
        return (
          window as unknown as {
            cameoCapture: {
              finish(): Promise<{ imageBase64: string; strokes: unknown[] }>;
            };
          }
        ).cameoCapture.finish();
      });
      if (timedOut || overMemory || this.stopped)
        throw new Error('Canvas capture exceeded its budget or was cancelled.');
      if (
        !Array.isArray(output.strokes) ||
        output.strokes.length > 10_000 ||
        output.imageBase64.length > 90 * 1024 ** 2
      )
        throw new Error('Canvas capture output exceeded its limit.');
      peakBytes = Math.max(
        peakBytes,
        await this.memoryBytes(server.process().pid!),
      );
      if (peakBytes > MAX_RENDER_BYTES)
        throw new Error('Canvas capture memory budget exceeded.');
      return {
        image: Buffer.from(output.imageBase64, 'base64'),
        strokes: output.strokes,
        elapsedMs: Date.now() - started,
        peakBytes,
      };
    } catch (error) {
      if (overMemory || timedOut)
        throw new Error(
          `Canvas capture exceeded its ${overMemory ? 'memory' : 'time'} budget (peakBytes=${peakBytes}).`,
          { cause: error },
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(memory);
      // Chromium 종료를 기다리고, 실패하면 다음 실행을 허용하지 않는다.
      await server.kill();
      this.server = undefined;
    }
  }

  /** 브라우저 자식의 RSS와 Node 사용량을 합쳐 heap만으로 성공을 판단하지 않는다. */
  private async memoryBytes(root: number): Promise<number> {
    const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,rss='], {
      maxBuffer: 4 * 1024 ** 2,
    });
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const ids = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, parent] of rows)
        if (ids.has(parent) && !ids.has(pid)) {
          ids.add(pid);
          changed = true;
        }
    }
    return rows.reduce(
      (sum, [pid, , rss]) => sum + (ids.has(pid) ? rss * 1024 : 0),
      process.memoryUsage().rss,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.server?.kill();
  }
}
