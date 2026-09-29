import { HttpErrorModule } from '../../common/exceptions/http-error.module';
import { HttpErrorMapperRegistry } from '../../common/exceptions/http-error-mapper.registry';
import { SampleHttpErrorMapper } from './presentation/errors/sample-http-error.mapper';
import { Module } from '@nestjs/common';
import { GetSampleByIdUseCase } from './application/get-sample-by-id.use-case';
import { ListSamplesUseCase } from './application/list-samples.use-case';
import { UpdateSampleNameUseCase } from './application/update-sample-name.use-case';
import { SampleCommandRepository } from './domain/repositories/sample-command.repository';
import { SampleReadRepository } from './domain/repositories/sample-read.repository';
import { SampleInMemoryRepository } from './infrastructure/persistence/sample.repository.in-memory';
import { SampleController } from './presentation/controllers/sample.controller';

@Module({
  imports: [HttpErrorModule],
  controllers: [SampleController],
  providers: [
    SampleHttpErrorMapper,
    SampleInMemoryRepository,
    {
      provide: SampleReadRepository,
      useExisting: SampleInMemoryRepository,
    },
    {
      provide: SampleCommandRepository,
      useExisting: SampleInMemoryRepository,
    },
    ListSamplesUseCase,
    GetSampleByIdUseCase,
    UpdateSampleNameUseCase,
  ],
  exports: [ListSamplesUseCase, GetSampleByIdUseCase, UpdateSampleNameUseCase],
})
export class SampleModule {
  constructor(
    registry: HttpErrorMapperRegistry,
    mapper: SampleHttpErrorMapper,
  ) {
    registry.register(mapper);
  }
}
