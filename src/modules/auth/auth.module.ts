import { Module } from '@nestjs/common';
import { ChallengeRepository } from './resources/challenge/challenge.repository';
import { CreateChallengeController } from './features/create-challenge/create-challenge.controller';
import { CreateChallengeUseCase } from './features/create-challenge/create-challenge.use-case';
import { LoginController } from './features/login/login.controller';
import { LoginUseCase } from './features/login/login.use-case';
import { WalletAccountRepository } from './resources/wallet-account/wallet-account.repository';
import { SessionRepository } from './resources/session/session.repository';
import { MeController } from './features/me/me.controller';
import { MeUseCase } from './features/me/me.use-case';
import { LogoutController } from './features/logout/logout.controller';
import { LogoutUseCase } from './features/logout/logout.use-case';

@Module({
  controllers: [
    CreateChallengeController,
    LoginController,
    MeController,
    LogoutController,
  ],
  providers: [
    ChallengeRepository,
    CreateChallengeUseCase,
    LoginUseCase,
    WalletAccountRepository,
    SessionRepository,
    MeUseCase,
    LogoutUseCase,
  ],
})
export class AuthModule {}
