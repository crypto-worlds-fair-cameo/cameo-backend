const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildAssetName,
  serializeSeasonMetadata,
} = require('../../dist/modules/season-nfts/resources/nft-media/season-nft-metadata');

test('asset name stays within 32 UTF-8 bytes without splitting code points or expanding placeholders', () => {
  const name = buildAssetName('$ID$' + '가😀'.repeat(30));

  assert.ok(Buffer.byteLength(name, 'utf8') <= 32);
  assert.equal(name.includes('$'), false);
  assert.equal(name.includes('\uFFFD'), false);
});

test('metadata serialization is deterministic and preserves the full season title only in attributes', () => {
  const input = {
    seasonId: '00000000-0000-4000-8000-000000000001',
    title: '$ID$ 함께 그린 그림 😀'.repeat(4),
    description: null,
    endedAt: '2026-10-09T01:00:00.000Z',
    contributors: 2,
    imageUri: 'https://arweave.net/immutable-image',
    imageSha256: 'a'.repeat(64),
  };

  const first = Buffer.from(serializeSeasonMetadata(input));
  const second = Buffer.from(serializeSeasonMetadata(input));
  assert.deepEqual(first, second);
  assert.equal(first.at(-1), '}'.charCodeAt(0));
  assert.equal(first.includes(Buffer.from([0xef, 0xbb, 0xbf])), false);

  const metadata = JSON.parse(first.toString('utf8'));
  assert.deepEqual(Object.keys(metadata), [
    'name',
    'description',
    'image',
    'attributes',
    'properties',
  ]);
  assert.equal(
    metadata.description,
    'A collaborative canvas completed on Cameo.',
  );
  assert.deepEqual(
    metadata.attributes.map((attribute) => attribute.trait_type),
    ['Season ID', 'Season Title', 'Ended At', 'Contributors', 'Image SHA256'],
  );
  assert.equal(metadata.attributes[1].value, input.title);
  assert.equal(metadata.attributes[3].value, 2);
  assert.deepEqual(metadata.properties, {
    files: [{ uri: input.imageUri, type: 'image/png' }],
    category: 'image',
  });
  assert.equal(Buffer.byteLength(metadata.name, 'utf8') <= 32, true);
  assert.equal(metadata.name.includes('$'), false);
});

test('metadata keeps a nonempty season description byte-for-byte', () => {
  const description = '  Original description stays untouched.  ';
  const bytes = serializeSeasonMetadata({
    seasonId: '00000000-0000-4000-8000-000000000002',
    title: 'Season',
    description,
    endedAt: '2026-10-09T01:00:00.000Z',
    contributors: 1,
    imageUri: 'https://arweave.net/image',
    imageSha256: 'b'.repeat(64),
  });

  assert.equal(
    JSON.parse(Buffer.from(bytes).toString('utf8')).description,
    description,
  );
});
