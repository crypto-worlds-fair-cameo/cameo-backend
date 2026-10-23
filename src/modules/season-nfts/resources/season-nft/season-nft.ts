export type SeasonNftNetwork = 'devnet' | 'mainnet-beta';

export type SeasonNftReleaseState =
  'WAITING_SNAPSHOT' | 'PREPARING' | 'READY' | 'EMPTY' | 'BLOCKED';

export type SeasonNftReleaseStage =
  | 'SNAPSHOT'
  | 'FROZEN'
  | 'IMAGE'
  | 'METADATA'
  | 'COLLECTION'
  | 'MACHINE'
  | 'LOCKED';

export type SeasonNftClaimState = 'UNCLAIMED' | 'PROCESSING' | 'CLAIMED';
export type SeasonNftReceiptState = 'NONE' | 'RESOLVING' | 'VERIFIED';

export type SeasonNftAttemptState =
  | 'QUEUED'
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTING'
  | 'CONFIRMING'
  | 'SUCCEEDED'
  | 'EXPIRED'
  | 'FAILED';

export type SeasonNftAttemptStep = 'ALLOWLIST_PROOF' | 'MINT';

export type SeasonNftTransactionState =
  | 'PREPARED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'RECONCILED'
  | 'FAILED'
  | 'EXPIRED';

export type SeasonNftTransactionKind =
  | 'SETUP_COLLECTION'
  | 'SETUP_MACHINE'
  | 'SETUP_GUARD'
  | 'SETUP_LOCK'
  | 'SETUP_CREATOR_MINT'
  | 'USER_PROOF'
  | 'USER_MINT';

export type SeasonNftUploadKind = 'IMAGE' | 'METADATA';
export type SeasonNftUploadState =
  'PREPARED' | 'UPLOADED' | 'VERIFIED' | 'FAILED';

export type SeasonNftReleaseRecord = Readonly<{
  id: string;
  seasonId: string;
  network: SeasonNftNetwork;
  state: SeasonNftReleaseState;
  stage: SeasonNftReleaseStage;
  version: bigint;
}>;

/** setup 거래가 재시도에서도 같은 업무 식별자를 사용하도록 단계와 순번을 고정한다. */
export function setupOperationKey(stage: string, substep: number): string {
  if (
    !/^[a-z][a-z0-9_-]*$/.test(stage) ||
    !Number.isSafeInteger(substep) ||
    substep < 0
  ) {
    throw new Error('Season NFT setup operation key is invalid.');
  }
  return `setup:${stage}:${substep}`;
}

/** 사용자 거래가 attempt와 proof 또는 mint 단계를 벗어나지 않도록 업무 식별자를 고정한다. */
export function claimOperationKey(
  attemptId: string,
  step: SeasonNftAttemptStep,
): string {
  return `claim:${attemptId}:${step}`;
}
