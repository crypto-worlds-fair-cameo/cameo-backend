const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  CanvasSnapshotFiles,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/canvas-snapshot-files');
const {
  CanvasSnapshotRepository,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/canvas-snapshot.repository');
const {
  FinalCanvasSnapshotReader,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/final-canvas-snapshot-reader');

let fixturePromise;

async function fixture() {
  fixturePromise ??= (async () => {
    const database = await testDatabaseModule();
    const storageRoot = await mkdtemp(join(tmpdir(), 'cameo-final-snapshot-'));
    const config = new ConfigService({
      canvasSnapshot: {
        enabled: true,
        storageRoot,
        publicBaseUrl: 'https://example.invalid/canvas',
        rendererVersion: 'test',
        captureIntervalMs: 60_000,
        diskBudgetBytes: 128 * 1024 * 1024,
        minFreeBytes: 1,
      },
    });
    class FinalSnapshotTestModule {}
    Module({
      imports: [database.module],
      providers: [
        { provide: ConfigService, useValue: config },
        CanvasSnapshotRepository,
        CanvasSnapshotFiles,
        FinalCanvasSnapshotReader,
      ],
    })(FinalSnapshotTestModule);
    const app = await NestFactory.createApplicationContext(
      FinalSnapshotTestModule,
      { logger: false },
    );
    const files = app.get(CanvasSnapshotFiles);
    await files.initialize();
    return {
      app,
      files,
      pool: database.pool,
      reader: app.get(FinalCanvasSnapshotReader),
      storageRoot,
    };
  })();
  return fixturePromise;
}

test.after(async () => {
  const current = await fixturePromise;
  await current?.app.close();
  if (current?.storageRoot)
    await rm(current.storageRoot, { recursive: true, force: true });
});

async function insertSeason(pool, lastChunkSequence = 0n) {
  const creatorId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at,
        last_chunk_sequence)
     VALUES ($1, 'season', 1000, 1000, 2,
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day', $2)`,
    [seasonId, lastChunkSequence.toString()],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Final snapshot test', 2)`,
    [seasonId, creatorId],
  );
  return seasonId;
}

function pngBytes() {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1000, 16);
  bytes.writeUInt32BE(1000, 20);
  return bytes;
}

async function insertFinalSnapshot(
  current,
  seasonId,
  { imageCanvasId = seasonId, throughSequence = 0n, bytes = pngBytes() } = {},
) {
  const snapshotId = randomUUID();
  const directory = `snapshots/seasons/${imageCanvasId}/${snapshotId}`;
  const absoluteDirectory = join(current.storageRoot, directory);
  await mkdir(absoluteDirectory, { recursive: true });
  await writeFile(join(absoluteDirectory, 'image.png'), bytes);
  await writeFile(join(absoluteDirectory, 'continuation.json'), '{}');
  const imageSha256 = createHash('sha256').update(bytes).digest('hex');
  await current.pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, $3, 'test', 1000, 1000, 'READY', true,
             $4, $5, $6, 2, $7, $8, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      throughSequence.toString(),
      `${directory}/image.png`,
      `${directory}/continuation.json`,
      bytes.byteLength,
      imageSha256,
      createHash('sha256').update('{}').digest('hex'),
    ],
  );
  return { snapshotId, imageSha256, bytes };
}

test('returns null only when the canvas has no final READY snapshot', async () => {
  const current = await fixture();
  const seasonId = await insertSeason(current.pool);

  assert.equal(await current.reader.read(seasonId), null);
});

test('reads exact final PNG bytes when the snapshot boundary equals the chunk head', async () => {
  const current = await fixture();
  const seasonId = await insertSeason(current.pool, 7n);
  const snapshot = await insertFinalSnapshot(current, seasonId, {
    throughSequence: 7n,
  });

  const result = await current.reader.read(seasonId);

  assert.equal(result.canvasId, seasonId);
  assert.equal(result.snapshotId, snapshot.snapshotId);
  assert.equal(result.throughSequence, 7n);
  assert.deepEqual(Buffer.from(result.pngBytes), snapshot.bytes);
  assert.equal(result.imageSha256, snapshot.imageSha256);
  assert.equal(result.byteLength, BigInt(snapshot.bytes.byteLength));
});

test('rejects a final snapshot whose boundary does not equal last_chunk_sequence', async () => {
  const current = await fixture();
  const seasonId = await insertSeason(current.pool, 8n);
  await insertFinalSnapshot(current, seasonId, { throughSequence: 7n });

  await assert.rejects(
    current.reader.read(seasonId),
    (error) =>
      error.code === 'NFT_FINAL_SNAPSHOT_INVALID' && /head/.test(error.message),
  );
});

test('rejects final PNG bytes whose SHA-256 differs from published metadata', async () => {
  const current = await fixture();
  const seasonId = await insertSeason(current.pool);
  const snapshot = await insertFinalSnapshot(current, seasonId);
  const imagePath = join(
    current.storageRoot,
    'snapshots',
    'seasons',
    seasonId,
    snapshot.snapshotId,
    'image.png',
  );
  const changed = Buffer.from(snapshot.bytes);
  changed[changed.length - 1] ^= 1;
  await writeFile(imagePath, changed);

  await assert.rejects(
    current.reader.read(seasonId),
    (error) =>
      error.code === 'NFT_FINAL_SNAPSHOT_INVALID' && /hash/.test(error.message),
  );
});

test('rejects a final snapshot image key bound to another canvas directory', async () => {
  const current = await fixture();
  const seasonId = await insertSeason(current.pool);
  const otherCanvasId = randomUUID();
  await insertFinalSnapshot(current, seasonId, {
    imageCanvasId: otherCanvasId,
  });

  await assert.rejects(
    current.reader.read(seasonId),
    (error) =>
      error.code === 'NFT_FINAL_SNAPSHOT_INVALID' &&
      /canvas/.test(error.message),
  );
});

test('propagates snapshot query outages instead of permanently blocking the release', async () => {
  const outage = new Error('snapshot database unavailable');
  const reader = new FinalCanvasSnapshotReader(
    { findFinalReady: async () => Promise.reject(outage) },
    { readImage: async () => Buffer.alloc(0) },
  );

  await assert.rejects(reader.read(randomUUID()), (error) => error === outage);
});

test('propagates operational image read failures instead of classifying them as corruption', async () => {
  const canvasId = randomUUID();
  const snapshotId = randomUUID();
  const outage = Object.assign(new Error('snapshot volume unavailable'), {
    code: 'EIO',
  });
  const reader = new FinalCanvasSnapshotReader(
    {
      findFinalReady: async () => ({
        snapshot: {
          id: snapshotId,
          canvasId,
          throughSequence: '0',
          imageKey: `snapshots/seasons/${canvasId}/${snapshotId}/image.png`,
          imageSha256: 'a'.repeat(64),
        },
        lastChunkSequence: '0',
      }),
    },
    { readImage: async () => Promise.reject(outage) },
  );

  await assert.rejects(reader.read(canvasId), (error) => error === outage);
});
