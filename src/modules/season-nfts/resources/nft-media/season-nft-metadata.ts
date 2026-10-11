export type SeasonMetadataInput = Readonly<{
  seasonId: string;
  title: string;
  description: string | null;
  endedAt: string;
  contributors: number;
  imageUri: string;
  imageSha256: string;
}>;

/** Candy Machine placeholder expansion을 막으면서 UTF-8 32 bytes 안의 공통 자산 이름을 만든다. */
export function buildAssetName(title: string): string {
  let name = 'Cameo ';
  // 전각 달러로 먼저 치환하고 code point 단위로 잘라 surrogate pair를 보존한다.
  for (const character of title.replaceAll('$', '＄')) {
    if (Buffer.byteLength(name + character, 'utf8') > 32) break;
    name += character;
  }
  return name;
}

/** 동결한 시즌 공통 정보와 검증된 이미지 URI를 고정 순서 JSON UTF-8 bytes로 직렬화한다. */
export function serializeSeasonMetadata(
  input: SeasonMetadataInput,
): Uint8Array {
  const metadata = {
    name: buildAssetName(input.title),
    description:
      input.description || 'A collaborative canvas completed on Cameo.',
    image: input.imageUri,
    attributes: [
      { trait_type: 'Season ID', value: input.seasonId },
      { trait_type: 'Season Title', value: input.title },
      { trait_type: 'Ended At', value: input.endedAt },
      { trait_type: 'Contributors', value: input.contributors },
      { trait_type: 'Image SHA256', value: input.imageSha256 },
    ],
    properties: {
      files: [{ uri: input.imageUri, type: 'image/png' }],
      category: 'image',
    },
  };

  return Buffer.from(JSON.stringify(metadata), 'utf8');
}
