import { Module } from '@nestjs/common';
import { ChallengeRepository } from './challenge/challenge.repository';
import { CreateChallengeController } from './create-challenge/create-challenge.controller';
import { CreateChallengeUseCase } from './create-challenge/create-challenge.use-case';

@Module({
  controllers: [CreateChallengeController],
  providers: [ChallengeRepository, CreateChallengeUseCase],
})
export class AuthModule {}
