import { Module } from '@nestjs/common';
import { ChallengeRepository } from './challenge/challenge.repository';
import { CreateChallengeController } from './create-challenge/create-challenge.controller';
import { CreateChallengeUseCase } from './create-challenge/create-challenge.use-case';
import { LoginController } from './login/login.controller';
import { LoginUseCase } from './login/login.use-case';
import { WalletAccountRepository } from './wallet-account/wallet-account.repository';
import { SessionRepository } from './session/session.repository';
import { MeController } from './me/me.controller';
import { MeUseCase } from './me/me.use-case';
import { LogoutController } from './logout/logout.controller';
import { LogoutUseCase } from './logout/logout.use-case';

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
