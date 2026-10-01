import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { SampleItem } from '../../resources/sample-item/sample-item';
import { SampleRepository } from '../../resources/sample-item/sample.repository';

@Injectable()
export class UpdateSampleNameUseCase {
  constructor(private readonly sampleRepository: SampleRepository) {}

  /** 샘플 이름의 공백·최소 길이를 확인하고 변경 내용을 저장한다. */
  async execute(id: string, newName: string): Promise<SampleItem> {
    const sample = await this.sampleRepository.findById(id);
    if (!sample) {
      throw new BusinessError(ErrorCodes.SampleNotFound);
    }

    const normalizedName = newName.trim();
    if (normalizedName.length < 2) {
      throw new BusinessError(ErrorCodes.SampleInvalidName);
    }

    return this.sampleRepository.save({
      ...sample,
      name: normalizedName,
    });
  }
}
