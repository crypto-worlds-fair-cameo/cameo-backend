import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import type { ProfileImageFormat } from './profile-image-format';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** 공개 경로에서 허용하는 파일 위치. 사용자 ID 폴더 아래의 사진 ID 파일만 노출한다. */
export const PROFILE_IMAGE_PUBLIC_PATH = new RegExp(
  `^/(${UUID})/(${UUID})\\.(png|jpg)$`,
);

export type StoredProfileImage = Readonly<{ url: string; filePath: string }>;

/** 프로필 사진을 저장 루트의 사용자별 폴더에 쓰고, 공개 주소와 파일 위치를 서로 변환한다. */
@Injectable()
export class ProfileImageStorage {
  private readonly storageRoot?: string;
  private readonly publicBaseUrl?: string;

  constructor(config: ConfigService<AllConfigType>) {
    this.storageRoot = config.get('profileImage.storageRoot', { infer: true });
    this.publicBaseUrl = config.get('profileImage.publicBaseUrl', {
      infer: true,
    });
  }

  get available(): boolean {
    return Boolean(this.storageRoot && this.publicBaseUrl);
  }

  /** 임시 파일을 다 쓴 뒤 이름을 바꿔, 공개 경로에 일부만 쓴 파일이 보이지 않게 한다. */
  async save(
    userId: string,
    imageId: string,
    format: ProfileImageFormat,
    bytes: Buffer,
  ): Promise<StoredProfileImage> {
    const { storageRoot, publicBaseUrl } = this.requireConfig();
    const fileName = `${imageId}.${format.extension}`;
    const directory = path.join(storageRoot, userId);
    const filePath = path.join(directory, fileName);
    const temporaryPath = path.join(directory, `.${fileName}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return { url: `${publicBaseUrl}/${userId}/${fileName}`, filePath };
  }

  async remove(image: StoredProfileImage): Promise<void> {
    await rm(image.filePath, { force: true });
  }

  /**
   * 이 저장소가 같은 사용자에게 발급한 주소만 파일 위치로 바꾼다.
   * 외부 주소나 다른 사용자 폴더를 가리키는 값은 지우지 않는다.
   */
  storedImage(userId: string, url: string | null): StoredProfileImage | null {
    if (!url || !this.available) return null;
    const { storageRoot, publicBaseUrl } = this.requireConfig();
    if (!url.startsWith(`${publicBaseUrl}/`)) return null;
    const match = PROFILE_IMAGE_PUBLIC_PATH.exec(
      url.slice(publicBaseUrl.length),
    );
    if (!match || match[1] !== userId) return null;
    return {
      url,
      filePath: path.join(storageRoot, userId, `${match[2]}.${match[3]}`),
    };
  }

  private requireConfig() {
    if (!this.storageRoot || !this.publicBaseUrl)
      throw new Error('Profile image storage is not configured.');
    return { storageRoot: this.storageRoot, publicBaseUrl: this.publicBaseUrl };
  }
}
