import { Injectable } from '@nestjs/common';
import { SampleItem } from '../domain/entities/sample-item.entity';
import { SampleReadRepository } from '../domain/repositories/sample-read.repository';

@Injectable()
export class ListSamplesUseCase {
  constructor(private readonly sampleReadRepository: SampleReadRepository) {}

  async execute(keyword?: string): Promise<SampleItem[]> {
    const samples = await this.sampleReadRepository.findAll();
    const normalizedKeyword = keyword?.trim().toLowerCase();

    if (!normalizedKeyword) {
      return samples;
    }

    return samples.filter((sample) => {
      return (
        sample.name.toLowerCase().includes(normalizedKeyword) ||
        sample.description.toLowerCase().includes(normalizedKeyword)
      );
    });
  }
}
