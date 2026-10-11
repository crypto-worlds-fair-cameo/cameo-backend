const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { ConfigService } = require('@nestjs/config');
const { DataItem } = require('@dha-team/arbundles');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { generateSigner } = require('@metaplex-foundation/umi');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  PrepareSeasonNftUseCase,
} = require('../../dist/modules/season-nfts/features/prepare-season-nft/prepare-season-nft.use-case');
const {
  NftUploadRepository,
} = require('../../dist/modules/season-nfts/resources/nft-media/nft-upload.repository');
const {
  TurboMediaPermanentError,
  TurboMediaPublisher,
} = require('../../dist/modules/season-nfts/resources/nft-media/turbo-media-publisher');
const {
  TurboSdkMediaTransport,
} = require('../../dist/modules/season-nfts/resources/nft-media/turbo-sdk-media-transport');
const {
  SeasonNftRepository,
} = require('../../dist/modules/season-nfts/resources/season-nft/season-nft.repository');

let fixturePromise;

async function fixture() {
  fixturePromise ??= (async () => {
    const database = await testDatabaseModule();
    const {
      PgTransactionRunner,
    } = require('../../dist/database/transaction/pg-transaction.runner');
    return {
      pool: database.pool,
      transactions: new PgTransactionRunner(database.pool),
      releases: new SeasonNftRepository(database.pool),
      uploads: new NftUploadRepository(database.pool),
    };
  })();
  return fixturePromise;
}

test.after(async () => {
  await fixturePromise;
});

async function createRelease(pool, stage = 'FROZEN') {
  const creatorId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const seasonId = randomUUID();
  const releaseId = randomUUID();
  const snapshotId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 1,
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, description, capacity)
     VALUES ($1, $2, 'Frozen media season', 'Original description', 2)`,
    [seasonId, creatorId],
  );
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 0, 'media-test', 1000, 1000, 'READY', true,
             $3, $4, 1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
      `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
      'a'.repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id, through_sequence,
        eligible_count, frozen_title, frozen_description, season_ended_at,
        image_byte_length, image_sha256, image_uri, version)
     VALUES ($1, $2, 'devnet', 'PREPARING', $3, $4, 0, 1,
             'Frozen media season', 'Original description',
             CURRENT_TIMESTAMP - interval '1 day', 1, $5,
             CASE WHEN $3 = 'IMAGE' THEN 'https://arweave.net/image-id' ELSE NULL END,
             0)`,
    [releaseId, seasonId, stage, snapshotId, 'a'.repeat(64)],
  );
  return { releaseId, seasonId, snapshotId };
}

async function sdkFixture(workRoot, name = 'service') {
  const umi = createUmi('http://127.0.0.1:8899');
  const signer = generateSigner(umi);
  const keyPath = join(workRoot, `${name}.json`);
  await writeFile(keyPath, JSON.stringify([...signer.secretKey]), {
    mode: 0o600,
  });
  await chmod(keyPath, 0o600);
  const config = new ConfigService({
    seasonNft: {
      serviceKeypairPath: keyPath,
      rpcUrl: 'http://127.0.0.1:8899',
      storageUploadUrl: 'https://upload.fixture.invalid',
      storagePaymentUrl: 'https://payment.fixture.invalid',
      storageGatewayUrl: 'https://gateway.fixture.invalid',
      uploadWorkDir: workRoot,
    },
  });
  return { config, transport: new TurboSdkMediaTransport(config) };
}

function imageInput(releaseId, bytes = Buffer.from('immutable image bytes')) {
  return {
    releaseId,
    kind: 'IMAGE',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function recoveryTransport(
  signer,
  payload,
  { loseFirstResponse = false } = {},
) {
  const signedItems = [];
  let signCalls = 0;
  let uploadCalls = 0;
  return {
    get signCalls() {
      return signCalls;
    },
    get uploadCalls() {
      return uploadCalls;
    },
    signedItems,
    signerPublicKey: () => signer.signerPublicKey(),
    sign: async (input) => {
      signCalls += 1;
      return signer.sign(input);
    },
    upload: async (input) => {
      uploadCalls += 1;
      signedItems.push(Buffer.from(input.signedItemBytes));
      if (loseFirstResponse && uploadCalls === 1) {
        const error = new Error('simulated upload response timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return {
        id: input.dataItemId,
        owner: 'fixture-owner',
        winc: '0',
        dataCaches: [],
        fastFinalityIndexes: [],
      };
    },
    fetch: async () =>
      new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
  };
}

test('upload response loss reuses one durable signed item after restart', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-recovery-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes, {
      loseFirstResponse: true,
    });
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      transport.fetch,
    );

    await assert.rejects(publisher.publish(input), /response timeout/);
    const prepared = await current.uploads.findItem(releaseId, 'IMAGE');
    assert.equal(prepared.state, 'PREPARED');
    const stored = await readFile(join(root, prepared.signedItemPath));

    const published = await publisher.publish(input);
    assert.equal(transport.signCalls, 1);
    assert.equal(transport.uploadCalls, 2);
    assert.deepEqual(transport.signedItems[0], transport.signedItems[1]);
    assert.deepEqual(stored, transport.signedItems[1]);
    assert.equal(published.dataItemId, prepared.dataItemId);
    assert.equal(published.uri, `https://arweave.net/${prepared.dataItemId}`);
    assert.equal(
      (await current.uploads.findItem(releaseId, 'IMAGE')).state,
      'VERIFIED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leader loss during upload prevents a later gateway or receipt write', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-leader-loss-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    let resolveUpload;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    let gatewayStarts = 0;
    const transport = {
      signerPublicKey: () => sdk.transport.signerPublicKey(),
      sign: (value) => sdk.transport.sign(value),
      upload: async (value) => {
        markStarted();
        await new Promise((resolve) => {
          resolveUpload = resolve;
        });
        return { id: value.dataItemId };
      },
    };
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      async () => {
        gatewayStarts += 1;
        return new Response(input.bytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      },
    );
    const controller = new AbortController();
    let active = true;
    const publishing = publisher.publish(input, {
      signal: controller.signal,
      assertMayStart: () => {
        if (!active) throw new Error('lost leadership');
      },
    });
    await started;
    active = false;
    controller.abort();
    resolveUpload();
    await assert.rejects(publishing, /abort/i);
    assert.equal(gatewayStarts, 0);
    assert.equal(
      (await current.uploads.findItem(releaseId, 'IMAGE')).state,
      'PREPARED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('receipt persistence retries DB-only serialization without repeating upload', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-db-retry-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    let receiptAttempts = 0;
    const uploads = {
      findItem: (...args) => current.uploads.findItem(...args),
      prepareItem: (...args) => current.uploads.prepareItem(...args),
      recordReceipt: (...args) => {
        receiptAttempts += 1;
        if (receiptAttempts === 1)
          throw Object.assign(new Error('serialization retry'), {
            code: '40001',
          });
        return current.uploads.recordReceipt(...args);
      },
      markVerified: (...args) => current.uploads.markVerified(...args),
    };
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      uploads,
      transport,
      transport.fetch,
    );
    await publisher.publish(input);
    assert.equal(transport.uploadCalls, 1);
    assert.equal(receiptAttempts, 2);
    assert.equal(
      (await current.uploads.findItem(releaseId, 'IMAGE')).state,
      'VERIFIED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fully verified file-before-DB orphan is adopted without signing replacement bytes', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-orphan-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    const interruptedRepository = {
      findItem: (...args) => current.uploads.findItem(...args),
      prepareItem: async () => {
        throw new Error('simulated crash before upload row commit');
      },
      recordReceipt: (...args) => current.uploads.recordReceipt(...args),
      markVerified: (...args) => current.uploads.markVerified(...args),
    };
    const interrupted = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      interruptedRepository,
      transport,
      transport.fetch,
    );
    await assert.rejects(
      interrupted.publish(input),
      /before upload row commit/,
    );
    assert.equal(transport.signCalls, 1);
    assert.equal(await current.uploads.findItem(releaseId, 'IMAGE'), null);

    const recovered = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      transport.fetch,
    );
    await recovered.publish(input);
    assert.equal(transport.signCalls, 1);
    assert.equal(transport.uploadCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an orphan signed by another key is rejected before signing, adoption, or upload', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-foreign-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const owner = await sdkFixture(root, 'owner');
    const foreign = await sdkFixture(root, 'foreign');
    const ownerTransport = recoveryTransport(owner.transport, input.bytes);
    const foreignBytes = await foreign.transport.sign({
      ...input,
      tags: TurboMediaPublisher.tagsFor(input),
    });
    const directory = join(root, releaseId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'image.signed'), foreignBytes, {
      mode: 0o600,
    });

    const publisher = new TurboMediaPublisher(
      owner.config,
      current.transactions,
      current.uploads,
      ownerTransport,
      ownerTransport.fetch,
    );
    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_SIGNED_ITEM_INVALID',
    );
    assert.equal(ownerTransport.signCalls, 0);
    assert.equal(ownerTransport.uploadCalls, 0);
    assert.equal(await current.uploads.findItem(releaseId, 'IMAGE'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orphan adoption rejects a different payload, tags, and prepared data item ID', async (t) => {
  for (const corruption of ['payload', 'tags', 'id']) {
    await t.test(corruption, async () => {
      const current = await fixture();
      const root = await mkdtemp(join(tmpdir(), `cameo-media-${corruption}-`));
      try {
        const { releaseId } = await createRelease(current.pool);
        const input = imageInput(releaseId);
        const sdk = await sdkFixture(root);
        const transport = recoveryTransport(sdk.transport, input.bytes);
        const signed = await sdk.transport.sign({
          bytes:
            corruption === 'payload'
              ? Buffer.from('different immutable bytes')
              : input.bytes,
          tags:
            corruption === 'tags'
              ? [{ name: 'Content-Type', value: 'image/png' }]
              : TurboMediaPublisher.tagsFor(input),
        });
        const directory = join(root, releaseId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        await writeFile(join(directory, 'image.signed'), signed, {
          mode: 0o600,
        });
        if (corruption === 'id') {
          const signedItemId = new DataItem(Buffer.from(signed)).id;
          await current.transactions.run((transaction) =>
            current.uploads.prepareItem(
              {
                releaseId,
                kind: 'IMAGE',
                sha256: input.sha256,
                byteLength: BigInt(input.bytes.length),
                dataItemId: `${signedItemId.slice(0, -1)}${signedItemId.endsWith('A') ? 'B' : 'A'}`,
                signedItemPath: `${releaseId}/image.signed`,
              },
              transaction,
            ),
          );
        }
        const publisher = new TurboMediaPublisher(
          sdk.config,
          current.transactions,
          current.uploads,
          transport,
          transport.fetch,
        );
        await assert.rejects(
          publisher.publish(input),
          (error) =>
            error instanceof TurboMediaPermanentError &&
            error.code === 'NFT_MEDIA_SIGNED_ITEM_INVALID',
        );
        assert.equal(transport.signCalls, 0);
        assert.equal(transport.uploadCalls, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('a PREPARED row with no durable file is permanent and never signs a replacement', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-missing-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    await current.transactions.run((transaction) =>
      current.uploads.prepareItem(
        {
          releaseId,
          kind: 'IMAGE',
          sha256: input.sha256,
          byteLength: BigInt(input.bytes.length),
          dataItemId: 'missing-item-id',
          signedItemPath: `${releaseId}/image.signed`,
        },
        transaction,
      ),
    );
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      transport.fetch,
    );

    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_SIGNED_ITEM_MISSING',
    );
    assert.equal(transport.signCalls, 0);
    assert.equal(transport.uploadCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlink at the durable signed-item path is a permanent invalid item', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-symlink-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    const signed = await sdk.transport.sign({
      bytes: input.bytes,
      tags: TurboMediaPublisher.tagsFor(input),
    });
    const externalPath = join(root, 'external.signed');
    const directory = join(root, releaseId);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(externalPath, signed, { mode: 0o600 });
    await symlink(externalPath, join(directory, 'image.signed'));
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      transport.fetch,
    );

    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_SIGNED_ITEM_INVALID',
    );
    assert.equal(transport.signCalls, 0);
    assert.equal(transport.uploadCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized durable signed-item envelope is rejected before reading or signing', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-envelope-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    const directory = join(root, releaseId);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, 'image.signed'),
      Buffer.alloc(input.bytes.length + 8 * 1024 + 1),
      { mode: 0o600 },
    );
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      transport.fetch,
    );

    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_SIGNED_ITEM_INVALID',
    );
    assert.equal(transport.signCalls, 0);
    assert.equal(transport.uploadCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway Content-Length mismatch is rejected without buffering the oversized body', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-oversize-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    let arrayBufferCalls = 0;
    const fetchOversized = async () => ({
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': String(input.bytes.length + 1),
      }),
      body: { cancel: async () => undefined },
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        throw new Error('unbounded gateway read was invoked');
      },
    });
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      fetchOversized,
    );

    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_HASH_MISMATCH',
    );
    assert.equal(arrayBufferCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway streaming body is capped when Content-Length is absent', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-stream-cap-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    let cancelCalls = 0;
    let arrayBufferCalls = 0;
    const fetchOversized = async () => ({
      status: 200,
      headers: new Headers({ 'Content-Type': 'image/png' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(input.bytes);
          controller.enqueue(Buffer.from('extra'));
        },
        cancel() {
          cancelCalls += 1;
        },
      }),
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        throw new Error('unbounded gateway read was invoked');
      },
    });
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      fetchOversized,
    );

    await assert.rejects(
      publisher.publish(input),
      (error) =>
        error instanceof TurboMediaPermanentError &&
        error.code === 'NFT_MEDIA_HASH_MISMATCH',
    );
    assert.equal(cancelCalls, 1);
    assert.equal(arrayBufferCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway Content-Length is treated as wire length for a decoded gzip body', async () => {
  const current = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-media-gzip-'));
  try {
    const { releaseId } = await createRelease(current.pool);
    const input = imageInput(releaseId);
    const sdk = await sdkFixture(root);
    const transport = recoveryTransport(sdk.transport, input.bytes);
    const fetchCompressed = async () =>
      new Response(input.bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Encoding': 'gzip',
          'Content-Length': '7',
        },
      });
    const publisher = new TurboMediaPublisher(
      sdk.config,
      current.transactions,
      current.uploads,
      transport,
      fetchCompressed,
    );

    const published = await publisher.publish(input);
    assert.equal(published.sha256, input.sha256);
    assert.equal(transport.uploadCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway byte mismatch blocks the release while 404 remains retryable', async () => {
  const current = await fixture();
  const { releaseId, seasonId, snapshotId } = await createRelease(current.pool);
  const sourceBytes = Buffer.from('x');
  await current.pool.query(
    `UPDATE season_nft_releases
     SET image_byte_length = $2, image_sha256 = $3 WHERE id = $1`,
    [
      releaseId,
      sourceBytes.length,
      createHash('sha256').update(sourceBytes).digest('hex'),
    ],
  );
  const snapshots = {
    read: async () => ({
      canvasId: seasonId,
      snapshotId,
      throughSequence: 0n,
      pngBytes: sourceBytes,
      imageSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      byteLength: 1n,
    }),
  };
  const mismatchPublisher = {
    publish: async () => {
      throw new TurboMediaPermanentError(
        'NFT_MEDIA_HASH_MISMATCH',
        'Public media bytes do not match the prepared bytes.',
      );
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    new ConfigService({ seasonNft: { enabled: true, network: 'devnet' } }),
    current.transactions,
    current.releases,
    undefined,
    snapshots,
    undefined,
    mismatchPublisher,
  );

  const result = await useCase.prepareMedia(releaseId);
  const row = (
    await current.pool.query(
      `SELECT state, last_error_code FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    )
  ).rows[0];
  assert.deepEqual(result, { releaseId, status: 'BLOCKED' });
  assert.deepEqual(row, {
    state: 'BLOCKED',
    last_error_code: 'NFT_MEDIA_HASH_MISMATCH',
  });

  const retryablePublisher = {
    publish: async () => {
      const error = new Error('Permanent gateway returned HTTP 404.');
      error.code = 'NFT_MEDIA_NOT_AVAILABLE';
      throw error;
    },
  };
  const retryRelease = await createRelease(current.pool);
  await current.pool.query(
    `UPDATE season_nft_releases
     SET image_byte_length = $2, image_sha256 = $3 WHERE id = $1`,
    [
      retryRelease.releaseId,
      sourceBytes.length,
      createHash('sha256').update(sourceBytes).digest('hex'),
    ],
  );
  snapshots.read = async () => ({
    canvasId: retryRelease.seasonId,
    snapshotId: retryRelease.snapshotId,
    throughSequence: 0n,
    pngBytes: sourceBytes,
    imageSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    byteLength: 1n,
  });
  const retryUseCase = new PrepareSeasonNftUseCase(
    new ConfigService({ seasonNft: { enabled: true, network: 'devnet' } }),
    current.transactions,
    current.releases,
    undefined,
    snapshots,
    undefined,
    retryablePublisher,
  );
  await assert.rejects(
    retryUseCase.prepareMedia(retryRelease.releaseId),
    /HTTP 404/,
  );
  assert.equal(
    (
      await current.pool.query(
        'SELECT state FROM season_nft_releases WHERE id = $1',
        [retryRelease.releaseId],
      )
    ).rows[0].state,
    'PREPARING',
  );
});

test('an EMPTY release never reads or uploads media', async () => {
  const current = await fixture();
  const { releaseId } = await createRelease(current.pool);
  await current.pool.query(
    `UPDATE season_nft_releases
     SET state = 'EMPTY', eligible_count = 0 WHERE id = $1`,
    [releaseId],
  );
  let snapshotReads = 0;
  let publishCalls = 0;
  const useCase = new PrepareSeasonNftUseCase(
    new ConfigService({ seasonNft: { enabled: true, network: 'devnet' } }),
    current.transactions,
    current.releases,
    undefined,
    {
      read: async () => {
        snapshotReads += 1;
        throw new Error('EMPTY release must not read snapshot bytes.');
      },
    },
    undefined,
    {
      publish: async () => {
        publishCalls += 1;
        throw new Error('EMPTY release must not upload media.');
      },
    },
  );

  assert.deepEqual(await useCase.prepareMedia(releaseId), {
    releaseId,
    status: 'EMPTY',
  });
  assert.equal(snapshotReads, 0);
  assert.equal(publishCalls, 0);
});

test('disabled media preparation refuses work before repository or external I/O', async () => {
  let repositoryReads = 0;
  let snapshotReads = 0;
  let publishCalls = 0;
  const useCase = new PrepareSeasonNftUseCase(
    new ConfigService({ seasonNft: { enabled: false, network: null } }),
    undefined,
    {
      findMediaSource: async () => {
        repositoryReads += 1;
        return null;
      },
    },
    undefined,
    {
      read: async () => {
        snapshotReads += 1;
        return null;
      },
    },
    undefined,
    {
      publish: async () => {
        publishCalls += 1;
        throw new Error('disabled preparation must not upload media');
      },
    },
  );

  await assert.rejects(useCase.prepareMedia(randomUUID()), /disabled/);
  assert.equal(repositoryReads, 0);
  assert.equal(snapshotReads, 0);
  assert.equal(publishCalls, 0);
});

test('media preparation advances one durable IMAGE or METADATA checkpoint per call', async () => {
  const current = await fixture();
  const { releaseId, seasonId, snapshotId } = await createRelease(current.pool);
  const imageBytes = Buffer.from('frozen image');
  const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
  await current.pool.query(
    `UPDATE season_nft_releases
     SET image_byte_length = $2, image_sha256 = $3 WHERE id = $1`,
    [releaseId, imageBytes.length, imageSha256],
  );
  let snapshotReads = 0;
  const snapshots = {
    read: async () => {
      snapshotReads += 1;
      return {
        canvasId: seasonId,
        snapshotId,
        throughSequence: 0n,
        pngBytes: imageBytes,
        imageSha256,
        byteLength: BigInt(imageBytes.length),
      };
    },
  };
  const calls = [];
  const publisher = {
    publish: async (input) => {
      calls.push({ ...input, bytes: Buffer.from(input.bytes) });
      return {
        uri: `https://arweave.net/${input.kind.toLowerCase()}-item`,
        sha256: input.sha256,
        dataItemId: `${input.kind.toLowerCase()}-item`,
      };
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    new ConfigService({ seasonNft: { enabled: true, network: 'devnet' } }),
    current.transactions,
    current.releases,
    undefined,
    snapshots,
    undefined,
    publisher,
  );

  assert.deepEqual(await useCase.prepareMedia(releaseId), {
    releaseId,
    status: 'IMAGE',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'IMAGE');
  assert.equal(
    (
      await current.pool.query(
        'SELECT stage FROM season_nft_releases WHERE id = $1',
        [releaseId],
      )
    ).rows[0].stage,
    'IMAGE',
  );

  assert.deepEqual(await useCase.prepareMedia(releaseId), {
    releaseId,
    status: 'METADATA',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'METADATA');
  assert.equal(snapshotReads, 1);
  const metadata = JSON.parse(calls[1].bytes.toString('utf8'));
  assert.equal(metadata.image, 'https://arweave.net/image-item');
  assert.equal(metadata.name, 'Cameo Frozen media season');
  assert.equal(metadata.description, 'Original description');
  assert.deepEqual(
    (
      await current.pool.query(
        `SELECT stage, asset_name, image_uri, metadata_uri
         FROM season_nft_releases WHERE id = $1`,
        [releaseId],
      )
    ).rows[0],
    {
      stage: 'METADATA',
      asset_name: 'Cameo Frozen media season',
      image_uri: 'https://arweave.net/image-item',
      metadata_uri: 'https://arweave.net/metadata-item',
    },
  );
});
