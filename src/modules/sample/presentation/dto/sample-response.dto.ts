import { SampleItem } from '../../domain/entities/sample-item.entity';

export class SampleResponseDto {
  id!: string;
  name!: string;
  description!: string;
  createdAt!: Date;

  static from(sample: SampleItem): SampleResponseDto {
    const dto = new SampleResponseDto();
    dto.id = sample.id;
    dto.name = sample.name;
    dto.description = sample.description;
    dto.createdAt = sample.createdAt;
    return dto;
  }
}
