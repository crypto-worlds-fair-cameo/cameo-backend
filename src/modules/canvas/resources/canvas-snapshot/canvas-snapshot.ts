import type {
  CanvasKey,
  CanvasTarget,
} from '../canvas-definition/canvas-target';

export type CanvasSnapshotStatus = 'READY' | 'INVALID';

/** 캡처 결과가 현재 DB 경계·시즌 상태와 맞지 않아 재시도 없이 폐기할 수 있음을 표시한다. */
export class CanvasSnapshotPublicationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = CanvasSnapshotPublicationRejected.name;
  }
}

export type CanvasSnapshotRecord = Readonly<{
  id: string;
  canvasId: string;
  canvasKey: CanvasKey;
  throughSequence: string;
  rendererVersion: string;
  width: number;
  height: number;
  status: CanvasSnapshotStatus;
  isFinal: boolean;
  imageKey: string;
  continuationKey: string;
  imageBytes: string;
  continuationBytes: string;
  imageSha256: string;
  continuationSha256: string;
  continuationSchemaVersion: number;
  capturedAt: Date;
  createdAt: Date;
}>;

export type CanvasSnapshotFileResult = Readonly<{
  imageKey: string;
  continuationKey: string;
  imageBytes: number;
  continuationBytes: number;
  imageSha256: string;
  continuationSha256: string;
  continuationSchemaVersion: 1;
}>;

export type CanvasSnapshotPublishInput = CanvasSnapshotFileResult &
  Readonly<{
    id: string;
    target: CanvasTarget;
    throughSequence: string;
    rendererVersion: string;
    isFinal: boolean;
    capturedAt: Date;
  }>;

export type CanvasBootstrapSnapshot = Readonly<{
  snapshotId: string;
  canvasKey: CanvasKey;
  throughSequence: string;
  imageUrl: string;
  imageSha256: string;
  width: number;
  height: number;
  rendererVersion: string;
  continuationStateUrl: string;
  continuationStateSha256: string;
  capturedAt: string;
}>;

export type CanvasBootstrapPayload = Readonly<{
  canvasKey: CanvasKey;
  epoch: string;
  snapshot: CanvasBootstrapSnapshot | null;
  baseSequence: string;
  headSequence: string;
}>;
