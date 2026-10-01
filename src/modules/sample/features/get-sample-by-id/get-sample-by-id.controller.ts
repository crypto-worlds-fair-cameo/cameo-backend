import { Controller, Get, Param } from '@nestjs/common';
import {
  toSampleResponse,
  type SampleResponse,
} from '../../resources/sample-item/sample-http';
import { GetSampleByIdUseCase } from './get-sample-by-id.use-case';

@Controller('samples')
export class GetSampleByIdController {
  constructor(private readonly getSampleByIdUseCase: GetSampleByIdUseCase) {}

  @Get(':id')
  async getById(@Param('id') id: string): Promise<SampleResponse> {
    const sample = await this.getSampleByIdUseCase.execute(id);
    return toSampleResponse(sample);
  }
}
