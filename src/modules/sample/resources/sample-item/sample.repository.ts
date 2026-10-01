import { Injectable } from '@nestjs/common';
import type { SampleItem } from './sample-item';

function createSeedSamples(): SampleItem[] {
  return [
    {
      id: 'sample_1',
      name: '대시보드 카드 예제',
      description:
        '리스트, 상세, 이름 변경 흐름을 확인하기 위한 기본 샘플 항목입니다.',
      createdAt: new Date('2025-01-12T09:00:00.000Z'),
    },
    {
      id: 'sample_2',
      name: 'API 응답 예제',
      description:
        '공통 응답 포맷과 컨트롤러-유스케이스 연결 방식을 보여주는 샘플입니다.',
      createdAt: new Date('2025-02-05T11:30:00.000Z'),
    },
    {
      id: 'sample_3',
      name: '레이아웃 연결 예제',
      description:
        '프론트와 백을 실제 도메인 없이 연결할 때 참고할 수 있는 범용 항목입니다.',
      createdAt: new Date('2025-02-18T15:45:00.000Z'),
    },
  ];
}

function copySample(sample: SampleItem): SampleItem {
  return {
    ...sample,
    createdAt: new Date(sample.createdAt),
  };
}

@Injectable()
export class SampleRepository {
  private readonly samples = new Map<string, SampleItem>(
    createSeedSamples().map((sample) => [sample.id, copySample(sample)]),
  );

  findAll(keyword?: string): Promise<SampleItem[]> {
    const normalizedKeyword = keyword?.trim().toLowerCase();
    const samples = Array.from(this.samples.values())
      .filter((sample) => {
        if (!normalizedKeyword) return true;
        return (
          sample.name.toLowerCase().includes(normalizedKeyword) ||
          sample.description.toLowerCase().includes(normalizedKeyword)
        );
      })
      .sort((left, right) => {
        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .map(copySample);

    return Promise.resolve(samples);
  }

  findById(id: string): Promise<SampleItem | null> {
    const sample = this.samples.get(id);
    return Promise.resolve(sample ? copySample(sample) : null);
  }

  save(sample: SampleItem): Promise<SampleItem> {
    const stored = copySample(sample);
    this.samples.set(stored.id, stored);
    return Promise.resolve(copySample(stored));
  }
}
