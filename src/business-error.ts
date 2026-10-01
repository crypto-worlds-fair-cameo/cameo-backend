export type BusinessErrorKind = 'not_found' | 'validation' | 'forbidden';

type BusinessErrorDefinition = Readonly<{
  code: string;
  kind: BusinessErrorKind;
  message: string;
}>;

/** 전송 방식과 무관한 업무 실패. message에는 공개 가능한 업무 설명만 담습니다. */
export class BusinessError extends Error {
  readonly code: string;
  readonly kind: BusinessErrorKind;

  constructor(definition: BusinessErrorDefinition) {
    super(definition.message);
    this.name = 'BusinessError';
    this.code = definition.code;
    this.kind = definition.kind;
  }
}
