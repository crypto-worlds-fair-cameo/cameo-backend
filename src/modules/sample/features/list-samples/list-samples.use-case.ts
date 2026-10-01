import { Injectable } from '@nestjs/common';
import type { SampleItem } from '../../resources/sample-item/sample-item';
import { SampleRepository } from '../../resources/sample-item/sample.repository';

@Injectable()
export class ListSamplesUseCase {
  constructor(private readonly sampleRepository: SampleRepository) {}

  execute(keyword?: string): Promise<SampleItem[]> {
    return this.sampleRepository.findAll(keyword);
  }
}
