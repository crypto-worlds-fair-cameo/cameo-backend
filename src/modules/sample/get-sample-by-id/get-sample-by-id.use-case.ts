import { Injectable } from '@nestjs/common';
import { BusinessError } from '../../../business-error';
import { SampleErrors, type SampleItem } from '../sample-item/sample-item';
import { SampleRepository } from '../sample-item/sample.repository';

@Injectable()
export class GetSampleByIdUseCase {
  constructor(private readonly sampleRepository: SampleRepository) {}

  async execute(id: string): Promise<SampleItem> {
    const sample = await this.sampleRepository.findById(id);
    if (!sample) {
      throw new BusinessError(SampleErrors.NotFound);
    }

    return sample;
  }
}
