export type BusinessErrorDefinition = Readonly<{
  statusCode: number;
  code: string;
  message: string;
}>;

/** 중앙 오류 정의의 HTTP 상태와 공개 정보를 전달하는 업무 예외입니다. */
export class BusinessError extends Error {
  readonly statusCode: number;
  readonly code: string;

  /** 발생한 업무 실패에 해당하는 중앙 정의로 예외를 생성합니다. */
  constructor(definition: BusinessErrorDefinition) {
    super(definition.message);
    this.name = 'BusinessError';
    this.statusCode = definition.statusCode;
    this.code = definition.code;
  }
}
