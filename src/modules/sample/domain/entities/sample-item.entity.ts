import { SampleErrorCode } from '../sample-error-code';
import { BusinessError } from '../../../../common/exceptions/business.error';

export class SampleItem {
  constructor(
    public readonly id: string,
    public name: string,
    public readonly description: string,
    public readonly createdAt: Date,
  ) {}

  changeName(newName: string) {
    const normalizedName = newName.trim();

    if (normalizedName.length < 2) {
      throw new BusinessError(
        SampleErrorCode.InvalidName,
        '이름은 공백을 제외하고 2자 이상이어야 합니다.',
      );
    }

    this.name = normalizedName;
  }
}
