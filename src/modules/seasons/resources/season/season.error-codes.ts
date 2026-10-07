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
} as const satisfies Record<string, BusinessErrorDefinition>;
