import { Body, Controller, Header, Patch, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
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
import {
  DISPLAY_NAME_MAX_LENGTH,
  UpdateDisplayNameUseCase,
} from './update-display-name.use-case';

class UpdateDisplayNameBody {
  @ApiProperty({
    minLength: 1,
    maxLength: DISPLAY_NAME_MAX_LENGTH,
    example: '카메오',
    description:
      '앞뒤 공백을 제거한 1~20자 닉네임. 중복은 허용하며 null과 NUL 문자는 허용하지 않습니다.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, DISPLAY_NAME_MAX_LENGTH)
  displayName!: string;
}

class UpdateDisplayNameResponse {
  @ApiProperty({ format: 'uuid', description: '현재 세션 사용자의 ID.' })
  id!: string;

  @ApiProperty({ example: '카메오' })
  displayName!: string;
}

@ApiTags('Users')
@Controller('users/me/display-name')
export class UpdateDisplayNameController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly updateDisplayName: UpdateDisplayNameUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 검증한 닉네임과 세션 쿠키만 업무 입력으로 전달하고 저장된 프로필을 반환한다. */
  @Patch()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '내 닉네임 설정·변경',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 최초 가입 후 닉네임을 설정하거나 기존 닉네임을 변경합니다. 앞뒤 공백을 제거하며 1~20자와 중복을 허용합니다. 사용자 ID와 기타 추가 필드는 무시합니다. 세션 수명과 쿠키는 변경하지 않습니다.',
  })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiBody({ type: UpdateDisplayNameBody, required: true })
  @ApiSuccessResponse(UpdateDisplayNameResponse)
  @ApiErrorResponses([
    AuthErrorCodes.AuthOriginNotAllowed,
    AuthErrorCodes.AuthSessionInvalid,
    AuthErrorCodes.AuthUserUnavailable,
    UserErrorCodes.UserDisplayNameInvalid,
  ])
  async update(
    @Body() body: UpdateDisplayNameBody,
    @Req() request: Request,
  ): Promise<UpdateDisplayNameResponse> {
    return this.updateDisplayName.execute(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      body.displayName,
    );
  }
}
