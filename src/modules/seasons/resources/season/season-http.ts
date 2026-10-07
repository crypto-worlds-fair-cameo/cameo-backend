import { ApiProperty } from '@nestjs/swagger';
import type { SeasonDetail, SeasonStatus } from './season';

/** 시즌 HTTP 응답의 날짜를 ISO 문자열로 고정하고 nullable 값을 명시한다. */
export class SeasonDetailResponse {
  @ApiProperty({ format: 'uuid', description: '시즌과 캔버스의 공통 ID.' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: '시즌 개설자 ID.' })
  creatorId!: string;

  @ApiProperty({ minLength: 1, maxLength: 50, example: '가을 공동 캔버스' })
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 100,
    example: '30일 동안 함께 완성하는 공개 캔버스',
  })
  description!: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: 500,
    maximum: 10000,
    example: 1000,
  })
  width!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 500,
    maximum: 10000,
    example: 1000,
  })
  height!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: 10,
    example: 3,
    description: '사용자별 획 제한. null이면 무제한입니다.',
  })
  strokeLimitPerUser!: number | null;

  @ApiProperty({ type: 'integer', minimum: 2, maximum: 100, example: 20 })
  capacity!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 1 })
  participantCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  forceEndedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    enum: ['scheduled', 'active', 'ended', 'cancelled'],
    example: 'active',
  })
  status!: SeasonStatus;

  @ApiProperty({ example: true })
  isParticipant!: boolean;

  @ApiProperty({ example: true })
  isCreator!: boolean;

  @ApiProperty({ example: false })
  canCancel!: boolean;

  @ApiProperty({ example: true })
  canEnd!: boolean;
}

export class SeasonListResponse {
  @ApiProperty({ type: () => SeasonDetailResponse, isArray: true })
  items!: SeasonDetailResponse[];

  @ApiProperty({ type: 'integer', minimum: 1, example: 1 })
  page!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 20 })
  limit!: number;

  @ApiProperty({ example: false })
  hasNext!: boolean;
}

/** transport-independent 시즌 결과의 모든 날짜를 JSON date-time 문자열로 변환한다. */
export function toSeasonDetailResponse(
  detail: SeasonDetail,
): SeasonDetailResponse {
  return {
    ...detail,
    startsAt: detail.startsAt.toISOString(),
    endsAt: detail.endsAt.toISOString(),
    cancelledAt: detail.cancelledAt?.toISOString() ?? null,
    forceEndedAt: detail.forceEndedAt?.toISOString() ?? null,
    createdAt: detail.createdAt.toISOString(),
  };
}

/** transport-independent 페이지의 item 날짜를 모두 HTTP date-time 문자열로 변환한다. */
export function toSeasonListResponse(page: {
  items: readonly SeasonDetail[];
  page: number;
  limit: number;
  hasNext: boolean;
}): SeasonListResponse {
  return {
    items: page.items.map(toSeasonDetailResponse),
    page: page.page,
    limit: page.limit,
    hasNext: page.hasNext,
  };
}
