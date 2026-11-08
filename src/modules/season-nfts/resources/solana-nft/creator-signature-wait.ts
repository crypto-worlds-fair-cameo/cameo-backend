/** 개설자 몫 NFT를 팬텀 창 하나에 같이 올리는 개수. */
export const CREATOR_MINT_BATCH_SIZE = 8;
/** 이 시간 동안 발행 화면을 다시 열지 않으면 서명 거래 갱신을 멈춘다. */
export const CREATOR_SIGNATURE_WAIT_MS = 10 * 60 * 1000;
/** 멈춘 뒤 화면을 열기 전까지 서버가 발행을 다시 집지 않는 시간. */
export const CREATOR_SIGNATURE_DEFER_MS = 6 * 60 * 60 * 1000;
/** 개설자 서명을 기다리는 동안만 쓰는 일시 정지 표시. release 상태는 PREPARING으로 둔다. */
export const CREATOR_AWAITING_SIGNATURE = 'NFT_AWAITING_CREATOR';

/**
 * 개설자가 최근에 발행 화면을 열었으면 만료된 서명 거래를 새로 만든다.
 * 화면을 연 기록이 없거나 기다림이 지나면 만들지 않는다.
 */
export function shouldRefreshCreatorTransaction(
  input: Readonly<{
    now: number;
    lastSeenAt: number | null;
    waitMs?: number;
  }>,
): boolean {
  if (input.lastSeenAt === null) return false;
  const waitMs = input.waitMs ?? CREATOR_SIGNATURE_WAIT_MS;
  return input.now - input.lastSeenAt < waitMs;
}

/** 팬텀에서 확인을 누르는 횟수. 준비 거래는 그대로고, 개설자 NFT는 묶음마다 한 번이다. */
export function creatorWalletApprovalCount(
  input: Readonly<{
    allocation: number;
    setupCount: number;
    paysStorage: boolean;
    batchSize?: number;
  }>,
): number {
  const batchSize = input.batchSize ?? CREATOR_MINT_BATCH_SIZE;
  const mintApprovals =
    input.allocation <= 0 ? 0 : Math.ceil(input.allocation / batchSize);
  return input.setupCount + (input.paysStorage ? 1 : 0) + mintApprovals;
}
