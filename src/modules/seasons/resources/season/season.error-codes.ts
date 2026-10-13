import type { BusinessErrorDefinition } from '@/business-error';

/** 시즌 생성·조회·상태 변경에서 공개할 HTTP 오류를 정의한다. */
export const SeasonErrorCodes = {
  SeasonInputInvalid: {
    statusCode: 400,
    code: 'SEASON_INPUT_INVALID',
    message: 'Season settings are invalid.',
    description: '시즌 설정이 허용 범위나 형식에 맞지 않습니다.',
  },
  SeasonNotFound: {
    statusCode: 404,
    code: 'SEASON_NOT_FOUND',
    message: 'Season not found.',
    description: '시즌을 찾을 수 없거나 현재 사용자에게 공개되지 않습니다.',
  },
  SeasonOwnerRequired: {
    statusCode: 403,
    code: 'SEASON_OWNER_REQUIRED',
    message: 'Only the season creator can perform this action.',
    description: '시즌 개설자만 이 작업을 수행할 수 있습니다.',
  },
  SeasonParticipationWalletMismatch: {
    statusCode: 403,
    code: 'SEASON_PARTICIPATION_WALLET_MISMATCH',
    message: 'Use the wallet that originally joined this season.',
    description: '현재 인증 지갑이 최초 참가 시 고정한 지갑과 다릅니다.',
  },
  SeasonActiveLimitReached: {
    statusCode: 409,
    code: 'SEASON_ACTIVE_LIMIT_REACHED',
    message: 'You can have at most 3 scheduled or active seasons.',
    description: '개설자가 보유할 수 있는 대기·진행 시즌은 최대 3개입니다.',
  },
  SeasonStateConflict: {
    statusCode: 409,
    code: 'SEASON_STATE_CONFLICT',
    message: 'This action is not allowed in the current season state.',
    description: '현재 시즌 상태에서는 이 작업을 수행할 수 없습니다.',
  },
  SeasonCapacityReached: {
    statusCode: 409,
    code: 'SEASON_CAPACITY_REACHED',
    message: 'This season is full.',
    description: '시즌 참가 정원이 가득 찼습니다.',
  },
  SeasonTemporarilyUnavailable: {
    statusCode: 503,
    code: 'SEASON_TEMPORARILY_UNAVAILABLE',
    message: 'Season is temporarily unavailable.',
    description: '시즌 서비스를 일시적으로 사용할 수 없습니다.',
  },
  SeasonEntryFeeUnavailable: {
    statusCode: 503,
    code: 'SEASON_ENTRY_FEE_UNAVAILABLE',
    message: 'Entry fee payments are unavailable right now.',
    description:
      '서버에 Solana network나 RPC가 설정되지 않았거나 RPC가 응답하지 않아 입장료를 처리할 수 없습니다.',
  },
  SeasonEntryPaymentRequired: {
    statusCode: 402,
    code: 'SEASON_ENTRY_PAYMENT_REQUIRED',
    message: 'Pay the entry fee to join this season.',
    description: '유료 시즌은 참가 API 대신 입장료 결제 API로 참가해야 합니다.',
  },
  SeasonEntryFeeNotRequired: {
    statusCode: 409,
    code: 'SEASON_ENTRY_FEE_NOT_REQUIRED',
    message: 'This season does not require an entry fee.',
    description:
      '무료 시즌이거나 개설자·기존 참가자라 입장료 결제가 필요하지 않습니다.',
  },
  SeasonEntryPaymentNotFound: {
    statusCode: 404,
    code: 'SEASON_ENTRY_PAYMENT_NOT_FOUND',
    message: 'Entry payment not found.',
    description: '결제가 없거나 현재 사용자·시즌의 결제가 아닙니다.',
  },
  SeasonEntryPaymentExpired: {
    statusCode: 409,
    code: 'SEASON_ENTRY_PAYMENT_EXPIRED',
    message: 'The payment request expired. Please try again.',
    description:
      '서명 기한이 지났거나 거래 blockhash가 만료되었습니다. 새 결제를 시작해야 합니다.',
  },
  SeasonEntryPaymentInvalidState: {
    statusCode: 409,
    code: 'SEASON_ENTRY_PAYMENT_INVALID_STATE',
    message: 'This payment is no longer awaiting a signature.',
    description: '결제가 이미 제출되었거나 종료된 상태입니다.',
  },
  SeasonEntryTransactionInvalid: {
    statusCode: 400,
    code: 'SEASON_ENTRY_TRANSACTION_INVALID',
    message: 'The signed transaction does not match the prepared payment.',
    description:
      '거래 형식·메시지·payer 또는 서명이 서버가 준비한 입장료 거래와 다릅니다.',
  },
  SeasonEntryPaymentFailed: {
    statusCode: 409,
    code: 'SEASON_ENTRY_PAYMENT_FAILED',
    message:
      'The entry fee transaction failed. Check your wallet balance and try again.',
    description:
      'RPC가 거래를 거절했거나 체인에서 실패했습니다. 잔액을 확인한 뒤 새 결제를 시작해야 합니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
