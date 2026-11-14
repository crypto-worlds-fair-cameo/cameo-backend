const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { ConfigService } = require('@nestjs/config');
const {
  CanvasSnapshotDerivativeRenderer,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/canvas-snapshot-derivative-renderer');
const {
  CanvasSnapshotFiles,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/canvas-snapshot-files');

const WIDTH = 3000;
const HEIGHT = 2000;

/** 흰 바탕에 색 띠를 그린 도화지 PNG를 만든다. */
async function canvasPng() {
  return sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: '#ffffff',
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 1200,
            height: 80,
            channels: 4,
            background: '#2b3fd1',
          },
        },
        left: 900,
        top: 960,
      },
    ])
    .png()
    .toBuffer();
}

async function storage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cameo-derivatives-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new CanvasSnapshotFiles(
    new ConfigService({
      canvasSnapshot: {
        enabled: true,
        storageRoot: root,
        publicBaseUrl: 'https://assets.example.test/canvas-assets',
        diskBudgetBytes: 256 * 1024 * 1024,
        minFreeBytes: 0,
      },
    }),
  );
  await files.initialize();
  return { root, files };
}

/** 시즌 도화지 하나의 스냅샷을 저장소에 공개한다. */
async function publish(files, image, derivatives) {
  const seasonId = randomUUID();
  const snapshotId = randomUUID();
  const target = {
    id: seasonId,
    key: `season:${seasonId}`,
    kind: 'season',
    width: WIDTH,
    height: HEIGHT,
    strokeLimitPerUser: 3,
    startsAt: null,
    endsAt: null,
  };
  const continuation = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      canvasKey: target.key,
      throughSequence: '1',
      rendererVersion: 'cameo-canvas-v1',
      strokes: [],
    }),
  );
  const result = await files.publish(
    target,
    snapshotId,
    '1',
    'cameo-canvas-v1',
    image,
    continuation,
    new Date(),
    derivatives,
  );
  return { result, directory: `snapshots/seasons/${seasonId}/${snapshotId}` };
}

test('derivative renderer shrinks a canvas PNG into preview and thumbnail WebP files', async () => {
  const derivatives = await new CanvasSnapshotDerivativeRenderer().render(
    await canvasPng(),
  );
  const preview = await sharp(derivatives.preview).metadata();
  const thumbnail = await sharp(derivatives.thumbnail).metadata();
  // 긴 변만 한도에 맞추고 도화지 비율은 유지한다.
  assert.deepEqual(
    [preview.format, preview.width, preview.height],
    ['webp', 2048, 1365],
  );
  assert.deepEqual(
    [thumbnail.format, thumbnail.width, thumbnail.height],
    ['webp', 768, 512],
  );
  assert.ok(derivatives.thumbnail.byteLength < derivatives.preview.byteLength);
  // 그린 색 띠가 축소본 가운데에도 남는다.
  const { data } = await sharp(derivatives.thumbnail)
    .extract({ left: 384, top: 256, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(data[2] > data[0] + 80, 'the blue stroke survives the shrink');
});

test('derivative renderer keeps a small canvas at its own size', async () => {
  const small = await sharp({
    create: { width: 500, height: 500, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const derivatives = await new CanvasSnapshotDerivativeRenderer().render(
    small,
  );
  const preview = await sharp(derivatives.preview).metadata();
  const thumbnail = await sharp(derivatives.thumbnail).metadata();
  assert.deepEqual([preview.width, preview.height], [500, 500]);
  assert.deepEqual([thumbnail.width, thumbnail.height], [500, 500]);
});

test('snapshot storage publishes derivatives beside the original and exposes their urls', async (t) => {
  const { root, files } = await storage(t);
  const image = await canvasPng();
  const derivatives = await new CanvasSnapshotDerivativeRenderer().render(
    image,
  );
  const { result, directory } = await publish(files, image, derivatives);

  assert.deepEqual(await files.derivativeUrls(result.imageKey), {
    previewUrl: `https://assets.example.test/canvas-assets/${directory}/preview.webp`,
    thumbnailUrl: `https://assets.example.test/canvas-assets/${directory}/thumbnail.webp`,
  });
  assert.deepEqual((await fs.readdir(path.join(root, directory))).sort(), [
    'continuation.json',
    'image.png',
    'preview.webp',
    'thumbnail.webp',
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(root, directory, 'thumbnail.webp')),
    derivatives.thumbnail,
  );
});

test('snapshot storage backfills derivatives for a snapshot published without them', async (t) => {
  const { root, files } = await storage(t);
  const image = await canvasPng();
  const { result, directory } = await publish(files, image);

  // 축소 그림이 없는 예전 스냅샷은 주소를 주지 않아 화면이 원본을 쓰게 한다.
  assert.equal(await files.hasDerivatives(result.imageKey), false);
  assert.deepEqual(await files.derivativeUrls(result.imageKey), {
    previewUrl: null,
    thumbnailUrl: null,
  });

  const derivatives = await new CanvasSnapshotDerivativeRenderer().render(
    image,
  );
  await files.saveDerivatives(result.imageKey, derivatives);

  assert.equal(await files.hasDerivatives(result.imageKey), true);
  assert.match(
    (await files.derivativeUrls(result.imageKey)).previewUrl,
    /\/preview\.webp$/,
  );
  assert.deepEqual((await fs.readdir(path.join(root, directory))).sort(), [
    'continuation.json',
    'image.png',
    'preview.webp',
    'thumbnail.webp',
  ]);
  // 임시 디렉터리에는 쓰다 만 파일이 남지 않는다.
  assert.deepEqual(await fs.readdir(path.join(root, '.tmp', 'snapshots')), []);
  // 원본 검증은 축소 그림이 추가돼도 그대로 통과한다.
  assert.equal(
    await files.validate(
      {
        imageKey: result.imageKey,
        continuationKey: result.continuationKey,
        imageBytes: String(result.imageBytes),
        continuationBytes: String(result.continuationBytes),
        imageSha256: result.imageSha256,
        continuationSha256: result.continuationSha256,
      },
      true,
    ),
    true,
  );
});

test('snapshot storage rejects derivative files that are not WebP', async (t) => {
  const { files } = await storage(t);
  const image = await canvasPng();
  const { result } = await publish(files, image);
  await assert.rejects(
    files.saveDerivatives(result.imageKey, {
      preview: image,
      thumbnail: image,
    }),
    /derivative image is invalid/,
  );
  assert.equal(await files.hasDerivatives(result.imageKey), false);
});

test('snapshot storage reports no derivatives while the feature is disabled', async () => {
  const files = new CanvasSnapshotFiles(
    new ConfigService({
      canvasSnapshot: { publicBaseUrl: 'https://assets.example.test' },
    }),
  );
  const key = `snapshots/main/${randomUUID()}/${randomUUID()}/image.png`;
  assert.deepEqual(await files.derivativeUrls(key), {
    previewUrl: null,
    thumbnailUrl: null,
  });
});
