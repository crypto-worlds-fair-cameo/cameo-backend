export type CanvasKey = 'main' | `season:${string}`;

export type CanvasTarget = Readonly<{
  id: string;
  key: CanvasKey;
  kind: 'main' | 'season';
  width: number;
  height: number;
  strokeLimitPerUser: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
}>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 외부 캔버스 키를 메인 또는 소문자 UUID v4 시즌 키로 정규화한다. */
export function parseCanvasKey(value: unknown): CanvasKey {
  // 키 생략과 명시한 main만 메인 캔버스로 해석한다.
  if (value === undefined || value === 'main') return 'main';

  // 문자열 시즌 키만 허용하고 UUID v4를 소문자로 고정한다.
  if (typeof value === 'string' && value.startsWith('season:')) {
    const seasonId = value.slice('season:'.length);
    if (UUID_V4_PATTERN.test(seasonId))
      return `season:${seasonId.toLowerCase()}`;
  }

  throw new TypeError('Canvas key is invalid.');
}
