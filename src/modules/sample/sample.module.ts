import { Module } from '@nestjs/common';
import { GetSampleByIdController } from './features/get-sample-by-id/get-sample-by-id.controller';
import { GetSampleByIdUseCase } from './features/get-sample-by-id/get-sample-by-id.use-case';
import { ListSamplesController } from './features/list-samples/list-samples.controller';
import { ListSamplesUseCase } from './features/list-samples/list-samples.use-case';
import { SampleRepository } from './resources/sample-item/sample.repository';
import { UpdateSampleNameController } from './features/update-sample-name/update-sample-name.controller';
import { UpdateSampleNameUseCase } from './features/update-sample-name/update-sample-name.use-case';

@Module({
  controllers: [
    ListSamplesController,
    GetSampleByIdController,
    UpdateSampleNameController,
  ],
  providers: [
    SampleRepository,
    ListSamplesUseCase,
    GetSampleByIdUseCase,
    UpdateSampleNameUseCase,
  ],
})
export class SampleModule {}
