import { BusinessError } from '@/business-error';
import { SeasonErrorCodes } from './season.error-codes';
import { getSeasonStatus, type SeasonStatus } from './season-state';

export { getSeasonStatus, type SeasonStatus } from './season-state';

export type CreateSeasonInput = Readonly<{
  title: string;
  description?: string;
  width?: number;
  height?: number;
  strokeLimitPerUser?: number | null;
  capacity: number;
  startsAt?: string;
  endsAt: string;
}>;

export type NormalizedSeasonInput = Readonly<{
  title: string;
  description: string | null;
  width: number;
  height: number;
  strokeLimitPerUser: number | null;
  capacity: number;
  startsAt: Date;
  endsAt: Date;
}>;

export type SeasonRecord = Readonly<{
  id: string;
  creatorId: string;
  title: string;
  description: string | null;
  width: number;
  height: number;
  strokeLimitPerUser: number | null;
  capacity: number;
  participantCount: number;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
  createdAt: Date;
}>;

export type SeasonDetail = SeasonRecord &
  Readonly<{
    status: SeasonStatus;
    isParticipant: boolean;
    isCreator: boolean;
    canCancel: boolean;
    canEnd: boolean;
  }>;

export type SeasonViewerContext = Readonly<{
  userId: string | undefined;
  isParticipant: boolean;
}>;

const DEFAULT_DIMENSION = 1000;
const DEFAULT_STROKE_LIMIT = 1;
const MIN_DIMENSION = 500;
const MAX_DIMENSION = 10000;
const MAX_TITLE_CODE_POINTS = 50;
const MAX_DESCRIPTION_CODE_POINTS = 100;
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 100;
const MIN_STROKE_LIMIT = 1;
const MAX_STROKE_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * HOUR_MS;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function invalidInput(): never {
  throw new BusinessError(SeasonErrorCodes.SeasonInputInvalid);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // 상위 surrogate는 바로 뒤의 하위 surrogate와 한 쌍이어야 한다.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
      continue;
    }
    // 앞의 상위 surrogate가 소비하지 않은 하위 surrogate는 잘못된 Unicode다.
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function normalizeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return invalidInput();
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > maximum ||
    normalized.includes('\0') ||
    hasLoneSurrogate(normalized)
  ) {
    return invalidInput();
  }
  return normalized;
}

function parseIsoDateTime(value: unknown): Date {
  if (typeof value !== 'string') return invalidInput();
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) return invalidInput();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));

  // UTC 임시값을 원문 달력 성분과 대조해 2월 30일 같은 자동 보정 날짜를 거절한다.
  const localTime = new Date(0);
  localTime.setUTCFullYear(year, month - 1, day);
  localTime.setUTCHours(hour, minute, second, millisecond);
  if (
    localTime.getUTCFullYear() !== year ||
    localTime.getUTCMonth() !== month - 1 ||
    localTime.getUTCDate() !== day ||
    localTime.getUTCHours() !== hour ||
    localTime.getUTCMinutes() !== minute ||
    localTime.getUTCSeconds() !== second ||
    localTime.getUTCMilliseconds() !== millisecond
  ) {
    return invalidInput();
  }

  let offsetMinutes = 0;
  // Z가 아니면 시각대 부호와 시·분을 절대 시각으로 환산한다.
  if (!match[8]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return invalidInput();
    offsetMinutes =
      (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  }

  const result = new Date(localTime.getTime() - offsetMinutes * 60 * 1000);
  return Number.isFinite(result.getTime()) ? result : invalidInput();
}

/** 생성 요청을 저장 가능한 값으로 정규화하고 현재 DB 시각 기준 예약·기간 규칙을 검증한다. */
export function normalizeSeasonInput(
  input: CreateSeasonInput,
  now: Date,
): NormalizedSeasonInput {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) {
    throw new RangeError('Current time is invalid.');
  }

  // 제목과 설명을 DB에 저장할 형태로 정리한다. 빈 설명만 NULL로 바꾼다.
  const title = normalizeText(input.title, MAX_TITLE_CODE_POINTS);
  let description: string | null = null;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') return invalidInput();
    const trimmed = input.description.trim();
    if (trimmed.length > 0) {
      description = normalizeText(trimmed, MAX_DESCRIPTION_CODE_POINTS);
    }
  }

  // undefined에만 기본값을 적용하고, 명시한 숫자는 정수 범위로 제한한다.
  const width = input.width === undefined ? DEFAULT_DIMENSION : input.width;
  const height = input.height === undefined ? DEFAULT_DIMENSION : input.height;
  const strokeLimitPerUser =
    input.strokeLimitPerUser === undefined
      ? DEFAULT_STROKE_LIMIT
      : input.strokeLimitPerUser;
  if (
    !isIntegerInRange(width, MIN_DIMENSION, MAX_DIMENSION) ||
    !isIntegerInRange(height, MIN_DIMENSION, MAX_DIMENSION) ||
    (strokeLimitPerUser !== null &&
      !isIntegerInRange(
        strokeLimitPerUser,
        MIN_STROKE_LIMIT,
        MAX_STROKE_LIMIT,
      )) ||
    !isIntegerInRange(input.capacity, MIN_CAPACITY, MAX_CAPACITY)
  ) {
    return invalidInput();
  }

  // 시작 생략은 현재 DB 시각이며, 명시한 시작은 현재부터 30일 이내여야 한다.
  const startsAt =
    input.startsAt === undefined
      ? new Date(nowTime)
      : parseIsoDateTime(input.startsAt);
  const endsAt = parseIsoDateTime(input.endsAt);
  const startsAtTime = startsAt.getTime();
  const duration = endsAt.getTime() - startsAtTime;
  if (
    startsAtTime < nowTime ||
    startsAtTime > nowTime + THIRTY_DAYS_MS ||
    duration < HOUR_MS ||
    duration > THIRTY_DAYS_MS
  ) {
    return invalidInput();
  }

  return {
    title,
    description,
    width,
    height,
    strokeLimitPerUser,
    capacity: input.capacity,
    startsAt,
    endsAt,
  };
}

/** 시즌 데이터에 조회 사용자 기준 참가·개설자 권한과 가능한 동작을 더한다. */
export function toSeasonDetail(
  record: SeasonRecord,
  now: Date,
  viewer: SeasonViewerContext,
): SeasonDetail {
  const status = getSeasonStatus(record, now);
  const isCreator = viewer.userId === record.creatorId;
  const isParticipant = viewer.userId !== undefined && viewer.isParticipant;
  return {
    ...record,
    status,
    isParticipant,
    isCreator,
    canCancel: isCreator && status === 'scheduled',
    canEnd: isCreator && status === 'active',
  };
}
