import { BusinessError } from '../../../../common/exceptions/business.error';
import { SampleItem } from './sample-item.entity';

describe('SampleItem', () => {
  it('trims and applies a valid name', () => {
    const sample = new SampleItem(
      'sample-1',
      '기존 이름',
      '설명',
      new Date('2024-01-01T00:00:00.000Z'),
    );

    sample.changeName('  새 이름  ');

    expect(sample.name).toBe('새 이름');
  });

  it('throws a domain validation error for blank-like values', () => {
    const sample = new SampleItem(
      'sample-1',
      '기존 이름',
      '설명',
      new Date('2024-01-01T00:00:00.000Z'),
    );

    expect(() => sample.changeName('  ')).toThrow(BusinessError);
    expect(() => sample.changeName('  ')).toThrow(
      '이름은 공백을 제외하고 2자 이상이어야 합니다.',
    );
  });
});
