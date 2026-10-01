export type SampleItem = Readonly<{
  id: string;
  name: string;
  description: string;
  createdAt: Date;
}>;

export const SampleErrors = {
  NotFound: {
    code: 'SAMPLE_NOT_FOUND',
    kind: 'not_found',
    message: '샘플 항목을 찾을 수 없습니다.',
  },
  InvalidName: {
    code: 'SAMPLE_INVALID_NAME',
    kind: 'validation',
    message: '이름은 공백을 제외하고 2자 이상이어야 합니다.',
  },
} as const;
