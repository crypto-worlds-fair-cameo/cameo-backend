import { Injectable } from '@nestjs/common';
import type { CanvasSnapshotDerivativeImages } from './canvas-snapshot';

/** 첫 화면용 그림의 긴 변(px). 전체 보기 도화지가 일반 모니터에서 차지하는 크기보다 크다. */
export const SNAPSHOT_PREVIEW_MAX_SIDE = 2048;
/** 목록 카드용 그림의 긴 변(px). */
export const SNAPSHOT_THUMBNAIL_MAX_SIDE = 768;
const MAX_SOURCE_PIXELS = 10_000 * 10_000;
const RENDER_TIMEOUT_SECONDS = 60;

type Sharp = typeof import('sharp');

/** 원본 PNG를 한 번만 풀어 첫 화면용·목록용 WebP 축소 그림을 만든다. */
@Injectable()
export class CanvasSnapshotDerivativeRenderer {
  private sharp?: Promise<Sharp>;

  async render(image: Buffer): Promise<CanvasSnapshotDerivativeImages> {
    const sharp = await this.load();
    // 최대 1억 픽셀인 원본을 줄 단위로 읽으면서 바로 줄여, 전체를 메모리에 펼치지 않는다.
    const { data, info } = await sharp(image, {
      sequentialRead: true,
      limitInputPixels: MAX_SOURCE_PIXELS,
    })
      .timeout({ seconds: RENDER_TIMEOUT_SECONDS })
      .flatten({ background: '#ffffff' })
      .resize({
        width: SNAPSHOT_PREVIEW_MAX_SIDE,
        height: SNAPSHOT_PREVIEW_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    // 작은 그림은 손실 압축한 중간 그림이 아니라 같은 픽셀에서 다시 줄여 화질 손실이 겹치지 않게 한다.
    const reduced = {
      raw: { width: info.width, height: info.height, channels: info.channels },
    };
    const [preview, thumbnail] = await Promise.all([
      sharp(data, reduced).webp({ quality: 82 }).toBuffer(),
      sharp(data, reduced)
        .resize({
          width: SNAPSHOT_THUMBNAIL_MAX_SIDE,
          height: SNAPSHOT_THUMBNAIL_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer(),
    ]);
    return { preview, thumbnail };
  }

  /**
   * 이미지 라이브러리는 처음 쓸 때 불러온다.
   * 기기에 맞는 실행 파일이 없어도 서버 시작은 막지 않고, 축소 그림만 건너뛰게 하기 위해서다.
   */
  private load(): Promise<Sharp> {
    this.sharp ??= import('sharp').then((module) => {
      const sharp = module.default;
      // 주기 작업이라 연산 결과를 캐시에 쌓아 둘 이유가 없다.
      sharp.cache(false);
      return sharp;
    });
    // 불러오기에 실패하면 다음 호출에서 다시 시도한다.
    this.sharp.catch(() => {
      this.sharp = undefined;
    });
    return this.sharp;
  }
}
