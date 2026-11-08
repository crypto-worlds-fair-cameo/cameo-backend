import { Injectable } from '@nestjs/common';

/** 이 서버 프로세스에서 개설자가 발행 화면을 연 시각. 재시작되면 비고, 그러면 갱신을 멈춘다. */
@Injectable()
export class CreatorSignaturePresence {
  private readonly seenAt = new Map<string, number>();

  mark(releaseId: string, now = Date.now()): void {
    this.seenAt.set(releaseId, now);
  }

  lastSeen(releaseId: string): number | null {
    return this.seenAt.get(releaseId) ?? null;
  }
}
