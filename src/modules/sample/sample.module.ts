import { Module } from '@nestjs/common';
import { GetSampleByIdController } from './get-sample-by-id/get-sample-by-id.controller';
import { GetSampleByIdUseCase } from './get-sample-by-id/get-sample-by-id.use-case';
import { ListSamplesController } from './list-samples/list-samples.controller';
import { ListSamplesUseCase } from './list-samples/list-samples.use-case';
import { SampleRepository } from './sample-item/sample.repository';
import { UpdateSampleNameController } from './update-sample-name/update-sample-name.controller';
import { UpdateSampleNameUseCase } from './update-sample-name/update-sample-name.use-case';

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
