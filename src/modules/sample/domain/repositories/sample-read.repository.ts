import { SampleItem } from '../entities/sample-item.entity';

export abstract class SampleReadRepository {
  abstract findAll(): Promise<SampleItem[]>;
  abstract findById(id: string): Promise<SampleItem | null>;
}
