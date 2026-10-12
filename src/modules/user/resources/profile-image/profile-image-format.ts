/** 디자인 기준(JPG·PNG, 최대 2MB)과 같은 업로드 본문 상한. */
export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 작은 파일로 큰 픽셀 수를 만드는 이미지가 화면 디코딩을 막지 않도록 한 변의 픽셀을 제한한다. */
export const PROFILE_IMAGE_MAX_DIMENSION = 8192;
export const PROFILE_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg'] as const;

export type ProfileImageFormat = Readonly<{
  mediaType: (typeof PROFILE_IMAGE_MEDIA_TYPES)[number];
  extension: 'png' | 'jpg';
  width: number;
  height: number;
}>;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** PNG 첫 chunk인 IHDR에서 크기를 읽는다. */
function readPng(bytes: Buffer): ProfileImageFormat | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    mediaType: 'image/png',
    extension: 'png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/** 길이 없는 marker를 건너뛰며 첫 SOF segment의 크기를 읽는다. 스캔 데이터 전에 없으면 거절한다. */
function readJpeg(bytes: Buffer): ProfileImageFormat | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // marker 앞의 0xff 채움 바이트는 여러 개일 수 있다.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    // DHT(C4)·JPG(C8)·DAC(CC)를 제외한 C0~CF가 프레임 크기를 담는다.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (length < 7) return null;
      return {
        mediaType: 'image/jpeg',
        extension: 'jpg',
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

/**
 * 요청한 Content-Type과 파일 시그니처가 같은 PNG·JPEG인지 확인하고 크기 제한을 적용한다.
 * 브라우저가 다른 형식으로 해석할 수 있는 파일은 저장하지 않는다.
 */
export function inspectProfileImage(
  bytes: Buffer,
  contentType: string | undefined,
): ProfileImageFormat | null {
  const mediaType = contentType?.split(';')[0].trim().toLowerCase();
  const format =
    mediaType === 'image/png'
      ? readPng(bytes)
      : mediaType === 'image/jpeg'
        ? readJpeg(bytes)
        : null;
  if (!format) return null;
  const valid = [format.width, format.height].every(
    (value) => value >= 1 && value <= PROFILE_IMAGE_MAX_DIMENSION,
  );
  return valid ? format : null;
}
