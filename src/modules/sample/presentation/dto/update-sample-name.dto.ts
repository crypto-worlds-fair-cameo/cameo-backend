import { IsString, MinLength } from 'class-validator';

export class UpdateSampleNameDto {
  @IsString()
  @MinLength(2)
  name!: string;
}
