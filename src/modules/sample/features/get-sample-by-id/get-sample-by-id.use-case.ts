import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { SampleItem } from '../../resources/sample-item/sample-item';
import { SampleRepository } from '../../resources/sample-item/sample.repository';

@Injectable()
export class GetSampleByIdUseCase {
  constructor(private readonly sampleRepository: SampleRepository) {}

  /** 샘플을 조회하고, 없는 ID는 공통 에러 코드로 전달한다. */
  async execute(id: string): Promise<SampleItem> {
    const sample = await this.sampleRepository.findById(id);
    if (!sample) {
      throw new BusinessError(ErrorCodes.SampleNotFound);
    }

    return sample;
  }
}
