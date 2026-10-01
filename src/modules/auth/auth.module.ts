import { Module } from '@nestjs/common';
import { ChallengeRepository } from './challenge/challenge.repository';
import { CreateChallengeController } from './create-challenge/create-challenge.controller';
import { CreateChallengeUseCase } from './create-challenge/create-challenge.use-case';
import { LoginController } from './login/login.controller';
import { LoginUseCase } from './login/login.use-case';
import { WalletAccountRepository } from './wallet-account/wallet-account.repository';
import { SessionRepository } from './session/session.repository';

@Module({
  controllers: [CreateChallengeController, LoginController],
  providers: [
    ChallengeRepository,
    CreateChallengeUseCase,
    LoginUseCase,
    WalletAccountRepository,
    SessionRepository,
  ],
})
export class AuthModule {}
