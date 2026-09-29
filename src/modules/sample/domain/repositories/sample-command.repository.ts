import { SampleItem } from '../entities/sample-item.entity';

export abstract class SampleCommandRepository {
  abstract save(sample: SampleItem): Promise<SampleItem>;
}
