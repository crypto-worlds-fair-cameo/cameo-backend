import type {
  SeasonNftClaimState,
  SeasonNftNetwork,
  SeasonNftReceiptState,
  SeasonNftReleaseStage,
  SeasonNftReleaseState,
} from './season-nft';
import { SeasonNftInternalErrorCodes } from './season-nft.error-codes';

export type SeasonNftAvailability =
  'WAITING_FOR_END' | 'PREPARING' | 'READY' | 'EMPTY' | 'UNAVAILABLE';

export type SeasonNftUnavailableReason =
  | 'CANCELLED'
  | 'FORCE_ENDED'
  | 'FEATURE_DISABLED'
  | 'TOO_MANY_CONTRIBUTORS'
  | null;

export type SeasonNftClaimEligibility =
  'ELIGIBLE' | 'NOT_PARTICIPANT' | 'NO_VALID_STROKE';

export type SeasonNftClaimView = Readonly<{
  eligibility: SeasonNftClaimEligibility;
  state: SeasonNftClaimState;
  walletAddress: string | null;
  activeAttemptId: string | null;
  assetAddress: string | null;
  signature: string | null;
  receiptState: SeasonNftReceiptState;
  claimedAt: string | null;
}>;

export type SeasonNftView = Readonly<{
  seasonId: string;
  network: SeasonNftNetwork;
  availability: SeasonNftAvailability;
  reason: SeasonNftUnavailableReason;
  name: string | null;
  imageUrl: string | null;
  metadataUri: string | null;
  eligibleCount: number | null;
  claim: SeasonNftClaimView;
}>;

export type SeasonNftViewSource = Readonly<{
  seasonId: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
  observedAt: Date;
  participantWalletAddress: string | null;
  ownStrokeCount: number;
  release: Readonly<{
    state: SeasonNftReleaseState;
    stage: SeasonNftReleaseStage;
    snapshotId: string | null;
    eligibleCount: number | null;
    assetName: string | null;
    imageUri: string | null;
    metadataUri: string | null;
    lastErrorCode: string | null;
  }> | null;
  claim: Readonly<{
    state: SeasonNftClaimState;
    walletAddress: string;
    activeAttemptId: string | null;
    assetAddress: string | null;
    signature: string | null;
    receiptState: SeasonNftReceiptState;
    claimedAt: Date | null;
  }> | null;
}>;

/** 시즌·release·현재 사용자 행을 공개 가능한 하나의 NFT 조회 결과로 해석한다. */
export function toSeasonNftView(
  source: SeasonNftViewSource,
  options: Readonly<{ enabled: boolean; network: SeasonNftNetwork }>,
): SeasonNftView {
  const { release } = source;
  let availability: SeasonNftAvailability;
  let reason: SeasonNftUnavailableReason = null;

  // 취소와 강제 종료는 기능 설정이나 release보다 우선하여 영구 수령 불가로 표시한다.
  if (source.cancelledAt !== null) {
    availability = 'UNAVAILABLE';
    reason = 'CANCELLED';
  } else if (source.forceEndedAt !== null) {
    availability = 'UNAVAILABLE';
    reason = 'FORCE_ENDED';
  } else if (!options.enabled) {
    // 비활성화는 새 수령을 막지만 아래의 기존 release와 claim 증거는 그대로 보존한다.
    availability = 'UNAVAILABLE';
    reason = 'FEATURE_DISABLED';
  } else if (source.observedAt.getTime() < source.endsAt.getTime()) {
    availability = 'WAITING_FOR_END';
  } else if (
    release?.state === 'BLOCKED' &&
    release.lastErrorCode === SeasonNftInternalErrorCodes.TooManyContributors
  ) {
    // 다른 BLOCKED 원인과 달리 운영 조치로 풀리지 않는 영구 미발행이므로 원인을 공개한다.
    availability = 'UNAVAILABLE';
    reason = 'TOO_MANY_CONTRIBUTORS';
  } else if (release?.state === 'EMPTY') {
    availability = 'EMPTY';
  } else if (release?.state === 'READY') {
    availability = 'READY';
  } else {
    // release 없음, 준비 중, 대기, BLOCKED를 모두 내부 원인 없는 준비 상태로 공개한다.
    availability = 'PREPARING';
  }

  const eligibility: SeasonNftClaimEligibility =
    source.participantWalletAddress === null
      ? 'NOT_PARTICIPANT'
      : source.ownStrokeCount < 1
        ? 'NO_VALID_STROKE'
        : 'ELIGIBLE';
  const claim = source.claim;
  const isParticipant = source.participantWalletAddress !== null;

  // snapshot을 고정한 release만 인원과 검증된 영구 media 필드를 공개한다.
  const isFrozen = release !== null && release.snapshotId !== null;
  return {
    seasonId: source.seasonId,
    network: options.network,
    availability,
    reason,
    name: isFrozen ? release.assetName : null,
    imageUrl: isFrozen ? release.imageUri : null,
    metadataUri: isFrozen ? release.metadataUri : null,
    eligibleCount: isFrozen ? release.eligibleCount : null,
    claim: {
      eligibility,
      state: claim?.state ?? 'UNCLAIMED',
      walletAddress: isParticipant
        ? (claim?.walletAddress ?? source.participantWalletAddress)
        : null,
      activeAttemptId: claim?.activeAttemptId ?? null,
      assetAddress: claim?.assetAddress ?? null,
      signature: claim?.signature ?? null,
      receiptState: claim?.receiptState ?? 'NONE',
      claimedAt: claim?.claimedAt?.toISOString() ?? null,
    },
  };
}
