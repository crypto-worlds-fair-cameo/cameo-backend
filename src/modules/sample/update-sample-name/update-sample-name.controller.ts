import { Body, Controller, Param, Patch } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import {
  toSampleResponse,
  type SampleResponse,
} from '../sample-item/sample-http';
import { UpdateSampleNameUseCase } from './update-sample-name.use-case';

class UpdateSampleNameDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

@Controller('samples')
export class UpdateSampleNameController {
  constructor(
    private readonly updateSampleNameUseCase: UpdateSampleNameUseCase,
  ) {}

  @Patch(':id/name')
  async updateName(
    @Param('id') id: string,
    @Body() body: UpdateSampleNameDto,
  ): Promise<SampleResponse> {
    const sample = await this.updateSampleNameUseCase.execute(id, body.name);
    return toSampleResponse(sample);
  }
}
