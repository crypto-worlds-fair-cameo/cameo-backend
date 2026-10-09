import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { CanvasSnapshotFiles } from '../../resources/canvas-snapshot/canvas-snapshot-files';
import { CanvasSnapshotRepository } from '../../resources/canvas-snapshot/canvas-snapshot.repository';

const CURSOR_VERSION = 1;
export const MAX_CANVAS_HISTORY_CURSOR_LENGTH = 512;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type CanvasHistoryCursor = Readonly<{
  v: typeof CURSOR_VERSION;
  canvasId: string;
  capturedAt: string;
  id: string;
}>;

/** 마지막 항목의 DB 시각과 ID를 고정 순서 JSON으로 만들어 불투명 커서로 반환한다. */
function encodeCanvasHistoryCursor(
  cursor: Omit<CanvasHistoryCursor, 'v'>,
): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, ...cursor }),
    'utf8',
  ).toString('base64url');
}

/** 정규 Base64URL과 고정 JSON 구조를 검사하고 요청 캔버스와 일치하는 커서만 반환한다. */
function decodeCanvasHistoryCursor(
  value: string,
  expectedCanvasId: string,
): CanvasHistoryCursor | undefined {
  // 비어 있거나 제한을 넘거나 정규 Base64URL 문자가 아닌 입력은 디코딩하지 않는다.
  if (
    value.length === 0 ||
    value.length > MAX_CANVAS_HISTORY_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }

  const bytes = Buffer.from(value, 'base64url');
  // 다른 패딩이나 철자로 같은 bytes를 표현한 커서는 허용하지 않는다.
  if (bytes.toString('base64url') !== value) return undefined;

  let json: string;
  // UTF-8이 아닌 bytes는 JSON 문자열로 대체 변환하지 않고 거절한다.
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  // JSON 문법이 아닌 payload는 잘못된 커서로 처리한다.
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  // 버전·필드·값 형식이 계약과 다르면 DB 조건으로 전달하지 않는다.
  if (!isCanvasHistoryCursor(parsed)) return undefined;

  // JSON 공백·키 순서·불필요한 속성을 거절해 한 의미에 하나의 커서만 허용한다.
  if (JSON.stringify(parsed) !== json) return undefined;
  // 다른 캔버스가 발급한 커서는 페이지 경계로 사용할 수 없다.
  if (parsed.canvasId !== expectedCanvasId.toLowerCase()) return undefined;
  return parsed;
}

function isCanvasHistoryCursor(value: unknown): value is CanvasHistoryCursor {
  // 커서는 배열이나 null이 아닌 JSON 객체여야 한다.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  // 고정 필드 외 입력과 PostgreSQL 조건으로 안전하게 변환할 수 없는 값은 거절한다.
  if (
    Object.keys(cursor).join(',') !== 'v,canvasId,capturedAt,id' ||
    cursor.v !== CURSOR_VERSION ||
    typeof cursor.canvasId !== 'string' ||
    typeof cursor.capturedAt !== 'string' ||
    typeof cursor.id !== 'string' ||
    !UUID_V4_PATTERN.test(cursor.canvasId) ||
    !UUID_V4_PATTERN.test(cursor.id) ||
    !CAPTURED_AT_PATTERN.test(cursor.capturedAt) ||
    cursor.capturedAt.startsWith('0000')
  ) {
    return false;
  }

  // JS가 검증 가능한 밀리초 부분을 재직렬화해 잘못된 달력 날짜를 거절한다.
  const millisecondIso = `${cursor.capturedAt.slice(0, 23)}Z`;
  const date = new Date(millisecondIso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === millisecondIso;
}

export type ListCanvasHistoryInput = Readonly<{
  canvasId: string;
  limit: number;
  cursor?: string;
}>;

export type CanvasHistoryItem = Readonly<{
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  capturedAt: Date;
  isFinal: boolean;
}>;

export type CanvasHistoryPage = Readonly<{
  items: CanvasHistoryItem[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

@Injectable()
export class ListCanvasHistoryUseCase {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly snapshots: CanvasSnapshotRepository,
    private readonly snapshotFiles: CanvasSnapshotFiles,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 공개된 캔버스의 READY 스냅샷을 불투명 커서 기준 최신순으로 조회한다. */
  async execute(
    token: string | undefined,
    input: ListCanvasHistoryInput,
  ): Promise<CanvasHistoryPage> {
    // HTTP 외 호출도 같은 1..100 범위를 벗어나면 DB 조회 전에 거절한다.
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new BusinessError(ErrorCodes.BadRequest);
    }
    const canvasId = input.canvasId.toLowerCase();
    const cursor = input.cursor
      ? decodeCanvasHistoryCursor(input.cursor, canvasId)
      : undefined;
    // 전달된 커서를 해석할 수 없거나 다른 캔버스에서 발급했으면 요청을 거절한다.
    if (input.cursor !== undefined && cursor === undefined) {
      throw new BusinessError(ErrorCodes.BadRequest);
    }

    return this.transactions.run(async (transaction) => {
      // 잘못되거나 사용할 수 없는 쿠키는 공개 조회를 막지 않는다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      const userId =
        authentication.outcome === 'authenticated'
          ? authentication.user.id
          : undefined;

      // 접근 조건과 페이지를 한 SQL snapshot에서 읽어 취소 전환 뒤 기록이 노출되지 않게 한다.
      const page = await this.snapshots.historyPage(
        {
          canvasId,
          userId,
          cursor,
          limit: input.limit + 1,
        },
        transaction,
      );
      // 없거나 공개되지 않은 캔버스는 같은 404로 존재를 숨긴다.
      if (!page.canvasExists) {
        throw new BusinessError(ErrorCodes.CanvasNotFound);
      }

      const pageRecords = page.records.slice(0, input.limit);
      const hasNext = page.records.length > input.limit;
      const last = pageRecords.at(-1);
      return {
        items: pageRecords.map((record) => ({
          id: record.id,
          imageUrl: this.snapshotFiles.publicUrl(record.imageKey),
          width: record.width,
          height: record.height,
          capturedAt: record.capturedAt,
          isFinal: record.isFinal,
        })),
        nextCursor:
          hasNext && last
            ? encodeCanvasHistoryCursor({
                canvasId,
                capturedAt: last.cursorCapturedAt,
                id: last.id,
              })
            : null,
        hasNext,
      };
    });
  }
}
