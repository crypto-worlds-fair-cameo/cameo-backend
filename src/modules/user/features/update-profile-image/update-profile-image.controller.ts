import { Controller, Header, Put, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import { UserErrorCodes } from '../../../../errors/user.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { PROFILE_IMAGE_MEDIA_TYPES } from '../../resources/profile-image/profile-image-format';
import { UpdateProfileImageUseCase } from './update-profile-image.use-case';

class UpdateProfileImageResponse {
  @ApiProperty({ format: 'uuid', description: '현재 세션 사용자의 ID.' })
  id!: string;

  @ApiProperty({
    format: 'uri',
    example:
      'https://api.cameoprint.com/profile-images/7a0c3f7e-8c55-4a0f-9a55-0f3c8f6f1d2a/3b6f3c1e-4d0a-4f8e-9a7b-2c1d5e6f7a8b.png',
    description: '새로 저장한 사진의 공개 주소. 바꿀 때마다 새 주소가 됩니다.',
  })
  avatarUrl!: string;
}

@ApiTags('Users')
@Controller('users/me/profile-image')
export class UpdateProfileImageController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly updateProfileImage: UpdateProfileImageUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 앱이 경로 전용 파서로 읽은 원본 이미지 바이트와 세션 쿠키를 업무 입력으로 전달한다. */
  @Put()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '내 프로필 사진 변경',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 본문에 PNG 또는 JPEG 파일 원본을 그대로 보내고 Content-Type을 파일 형식과 같게 지정합니다. 최대 2MB입니다. 성공하면 사용자의 avatarUrl이 새 주소로 바뀌고 이전 사진 파일은 삭제됩니다.',
  })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiConsumes(...PROFILE_IMAGE_MEDIA_TYPES)
  @ApiBody({
    required: true,
    schema: { type: 'string', format: 'binary' },
    description: 'PNG 또는 JPEG 파일 원본(최대 2MB, 가로·세로 8192px 이하).',
  })
  @ApiSuccessResponse(UpdateProfileImageResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    UserErrorCodes.UserProfileImageInvalid,
    UserErrorCodes.UserProfileImageUnavailable,
  ])
  async update(@Req() request: Request): Promise<UpdateProfileImageResponse> {
    return this.updateProfileImage.execute(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      request.get('Content-Type'),
      request.body,
    );
  }
}
