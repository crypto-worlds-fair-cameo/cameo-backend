import type { BusinessErrorDefinition } from '@/business-error';

/** NFT HTTP 경계가 공개하는 상태·코드·영어 메시지를 정의한다. */
export const SeasonNftErrorCodes = {
  NftNotEligible: {
    statusCode: 403,
    code: 'NFT_NOT_ELIGIBLE',
    message: 'You are not eligible to claim this season NFT.',
    description: '시즌 참가 또는 유효 획 자격이 없습니다.',
  },
  NftWalletMismatch: {
    statusCode: 403,
    code: 'NFT_WALLET_MISMATCH',
    message: 'Use the wallet that participated in this season.',
    description: '현재 인증 지갑이 시즌 참가 때 고정한 지갑과 다릅니다.',
  },
  NftClaimAttemptNotFound: {
    statusCode: 404,
    code: 'NFT_CLAIM_ATTEMPT_NOT_FOUND',
    message: 'Claim attempt not found.',
    description: '시도가 없거나 현재 사용자·시즌 소유가 아닙니다.',
  },
  NftSeasonUnavailable: {
    statusCode: 409,
    code: 'NFT_SEASON_UNAVAILABLE',
    message: 'This season is not eligible for NFT claims.',
    description: '취소된 시즌은 NFT 수령 대상이 아닙니다.',
  },
  NftMintNotCreator: {
    statusCode: 403,
    code: 'NFT_MINT_NOT_CREATOR',
    message: 'Only the season creator can mint this NFT.',
    description: '시즌 개설자만 NFT를 발행할 수 있습니다.',
  },
  NftMintNotEnded: {
    statusCode: 409,
    code: 'NFT_MINT_NOT_ENDED',
    message: 'The season has not ended yet.',
    description: '끝나지 않은 시즌은 NFT를 발행할 수 없습니다.',
  },
  NftMintSupplyTooSmall: {
    statusCode: 400,
    code: 'NFT_MINT_SUPPLY_TOO_SMALL',
    message: 'The supply must be at least the number of eligible participants.',
    description: '발행 수량은 받을 수 있는 사람 수 이상이어야 합니다.',
  },
  NftMintAllocationTooLarge: {
    statusCode: 400,
    code: 'NFT_MINT_ALLOCATION_TOO_LARGE',
    message: 'The creator allocation exceeds the on-chain mint limit.',
    description: '개설자 지갑으로 바로 넣는 수량은 65535개를 넘을 수 없습니다.',
  },
  NftNotReady: {
    statusCode: 409,
    code: 'NFT_NOT_READY',
    message: 'The season NFT is not ready to claim.',
    description: '시즌 종료 또는 NFT 발행 준비가 완료되지 않았습니다.',
  },
  NftTransactionExpired: {
    statusCode: 409,
    code: 'NFT_TRANSACTION_EXPIRED',
    message: 'The transaction has expired. Please try again.',
    description: '체인 증거로 거래 만료가 확인되었습니다.',
  },
  NftTransactionInvalidState: {
    statusCode: 409,
    code: 'NFT_TRANSACTION_INVALID_STATE',
    message: 'This transaction is no longer awaiting a signature.',
    description: '지정 거래가 더 이상 최초 서명을 접수할 상태가 아닙니다.',
  },
  NftTransactionInvalid: {
    statusCode: 400,
    code: 'NFT_TRANSACTION_INVALID',
    message: 'The signed transaction does not match the prepared transaction.',
    description:
      '거래 형식·메시지·payer 또는 필수 서명이 준비 거래와 다릅니다.',
  },
  NftServiceUnavailable: {
    statusCode: 503,
    code: 'NFT_SERVICE_UNAVAILABLE',
    message: 'NFT claims are temporarily unavailable.',
    description:
      '현재 network 설정이 없어 정확한 NFT 조회 결과를 제공할 수 없습니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;

/** worker와 운영 로그가 사용하는 내부 NFT 준비 오류 코드를 고정한다. */
export const SeasonNftInternalErrorCodes = {
  EligibilityCorrupt: 'NFT_ELIGIBILITY_CORRUPT',
  FinalSnapshotInvalid: 'NFT_FINAL_SNAPSHOT_INVALID',
  MediaSourceInvalid: 'NFT_MEDIA_SOURCE_INVALID',
  SourceIneligible: 'NFT_SOURCE_INELIGIBLE',
  TooManyContributors: 'NFT_TOO_MANY_CONTRIBUTORS',
  SupplyBelowEligible: 'NFT_SUPPLY_BELOW_ELIGIBLE',
} as const;
