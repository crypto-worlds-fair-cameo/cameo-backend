import { IsOptional, IsString } from 'class-validator';

export class ListSamplesQueryDto {
  @IsOptional()
  @IsString()
  q?: string;
}
