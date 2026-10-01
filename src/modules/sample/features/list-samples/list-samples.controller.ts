import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import {
  toSampleResponse,
  type SampleResponse,
} from '../../resources/sample-item/sample-http';
import { ListSamplesUseCase } from './list-samples.use-case';

class ListSamplesQueryDto {
  @IsOptional()
  @IsString()
  q?: string;
}

@Controller('samples')
export class ListSamplesController {
  constructor(private readonly listSamplesUseCase: ListSamplesUseCase) {}

  @Get()
  async list(@Query() query: ListSamplesQueryDto): Promise<SampleResponse[]> {
    const samples = await this.listSamplesUseCase.execute(query.q);
    return samples.map(toSampleResponse);
  }
}
