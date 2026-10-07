export type SeasonStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';

export type SeasonState = Readonly<{
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
}>;

/** 저장된 종료 표식과 `[startsAt, endsAt)` 경계로 시즌의 현재 상태를 계산한다. */
export function getSeasonStatus(season: SeasonState, now: Date): SeasonStatus {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime))
    throw new RangeError('Current time is invalid.');
  // 취소가 다른 종료 조건보다 우선하며, 강제 종료나 예정 종료 경계부터 ended다.
  if (season.cancelledAt !== null) return 'cancelled';
  if (season.forceEndedAt !== null || nowTime >= season.endsAt.getTime())
    return 'ended';
  if (nowTime < season.startsAt.getTime()) return 'scheduled';
  return 'active';
}
