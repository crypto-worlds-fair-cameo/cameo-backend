import { Injectable } from '@nestjs/common';
import { SampleItem } from '../../domain/entities/sample-item.entity';
import { SampleCommandRepository } from '../../domain/repositories/sample-command.repository';
import { SampleReadRepository } from '../../domain/repositories/sample-read.repository';

const seededSamples = [
  new SampleItem(
    'sample_1',
    '대시보드 카드 예제',
    '리스트, 상세, 이름 변경 흐름을 확인하기 위한 기본 샘플 항목입니다.',
    new Date('2025-01-12T09:00:00.000Z'),
  ),
  new SampleItem(
    'sample_2',
    'API 응답 예제',
    '공통 응답 포맷과 컨트롤러-유스케이스 연결 방식을 보여주는 샘플입니다.',
    new Date('2025-02-05T11:30:00.000Z'),
  ),
  new SampleItem(
    'sample_3',
    '레이아웃 연결 예제',
    '프론트와 백을 실제 도메인 없이 연결할 때 참고할 수 있는 범용 항목입니다.',
    new Date('2025-02-18T15:45:00.000Z'),
  ),
];

@Injectable()
export class SampleInMemoryRepository
  implements SampleReadRepository, SampleCommandRepository
{
  private readonly samples = new Map<string, SampleItem>(
    seededSamples.map((sample) => [sample.id, sample]),
  );

  findAll(): Promise<SampleItem[]> {
    return Promise.resolve(
      Array.from(this.samples.values()).sort((left, right) => {
        return left.createdAt.getTime() - right.createdAt.getTime();
      }),
    );
  }

  findById(id: string): Promise<SampleItem | null> {
    return Promise.resolve(this.samples.get(id) ?? null);
  }

  save(sample: SampleItem): Promise<SampleItem> {
    this.samples.set(sample.id, sample);
    return Promise.resolve(sample);
  }
}
