import type { SampleItem } from './sample-item';

export type SampleResponse = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
};

export function toSampleResponse(sample: SampleItem): SampleResponse {
  return {
    id: sample.id,
    name: sample.name,
    description: sample.description,
    createdAt: sample.createdAt,
  };
}
