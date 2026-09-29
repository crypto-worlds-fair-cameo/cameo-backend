import { BusinessError } from '../../../common/exceptions/business.error';
import { SampleErrorCode } from '../domain/sample-error-code';
import { Injectable } from '@nestjs/common';
import { SampleItem } from '../domain/entities/sample-item.entity';
import { SampleCommandRepository } from '../domain/repositories/sample-command.repository';
import { SampleReadRepository } from '../domain/repositories/sample-read.repository';

@Injectable()
export class UpdateSampleNameUseCase {
  constructor(
    private readonly sampleReadRepository: SampleReadRepository,
    private readonly sampleCommandRepository: SampleCommandRepository,
  ) {}

  async execute(id: string, newName: string): Promise<SampleItem> {
    const sample = await this.sampleReadRepository.findById(id);
    if (!sample) {
      throw new BusinessError(
        SampleErrorCode.NotFound,
        '샘플 항목을 찾을 수 없습니다.',
      );
    }

    sample.changeName(newName);
    return this.sampleCommandRepository.save(sample);
  }
}
