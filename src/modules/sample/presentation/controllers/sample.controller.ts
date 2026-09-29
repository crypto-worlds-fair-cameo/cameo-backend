import { ListSamplesQueryDto } from '../dto/list-samples-query.dto';
import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { GetSampleByIdUseCase } from '../../application/get-sample-by-id.use-case';
import { ListSamplesUseCase } from '../../application/list-samples.use-case';
import { UpdateSampleNameUseCase } from '../../application/update-sample-name.use-case';
import { UpdateSampleNameDto } from '../dto/update-sample-name.dto';
import { SampleResponseDto } from '../dto/sample-response.dto';

@Controller('samples')
export class SampleController {
  constructor(
    private readonly listSamplesUseCase: ListSamplesUseCase,
    private readonly getSampleByIdUseCase: GetSampleByIdUseCase,
    private readonly updateSampleNameUseCase: UpdateSampleNameUseCase,
  ) {}

  @Get()
  async list(
    @Query() query: ListSamplesQueryDto,
  ): Promise<SampleResponseDto[]> {
    const samples = await this.listSamplesUseCase.execute(query.q);
    return samples.map((sample) => SampleResponseDto.from(sample));
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<SampleResponseDto> {
    const sample = await this.getSampleByIdUseCase.execute(id);
    return SampleResponseDto.from(sample);
  }

  @Patch(':id/name')
  async updateName(
    @Param('id') id: string,
    @Body() body: UpdateSampleNameDto,
  ): Promise<SampleResponseDto> {
    const sample = await this.updateSampleNameUseCase.execute(id, body.name);
    return SampleResponseDto.from(sample);
  }
}
