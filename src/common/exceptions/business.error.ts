/** 전송 방식과 무관한 업무 실패. 공개 메시지는 presentation mapper가 결정합니다. */
export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}
