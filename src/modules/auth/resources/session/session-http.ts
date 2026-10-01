import { ApiProperty } from '@nestjs/swagger';
import type { SessionLifetime } from './session.repository';

class WalletResponse {
  @ApiProperty({ example: 'solana' })
  chainNamespace!: string;

  @ApiProperty({ example: '6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L' })
  address!: string;
}

class AuthenticatedUserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: '사용자-a7f29c41' })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  avatarUrl!: string | null;

  @ApiProperty({ type: [WalletResponse] })
  wallets!: ReadonlyArray<WalletResponse>;
}

class SessionLifetimeResponse implements SessionLifetime {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '미접속 만료 시각. 활동 시 최대 7일로 연장됩니다.',
  })
  expiresAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '최초 발급 후 30일의 절대 만료 시각.',
  })
  absoluteExpiresAt!: Date;
}

/** 로그인과 현재 사용자 조회에서 함께 사용하는 공개 사용자·세션 응답이다. */
export class AuthenticatedSessionResponse {
  @ApiProperty({ type: AuthenticatedUserResponse })
  user!: AuthenticatedUserResponse;

  @ApiProperty({ type: SessionLifetimeResponse })
  session!: SessionLifetimeResponse;
}
