import { Module } from '@nestjs/common';
import { LoggerModule } from '../../logging/logger.module';
import { AuthModule } from '../auth/auth.module';
import { GetWalletBalanceController } from './features/get-wallet-balance/get-wallet-balance.controller';
import { GetWalletBalanceUseCase } from './features/get-wallet-balance/get-wallet-balance.use-case';
import { ListTransactionsController } from './features/list-transactions/list-transactions.controller';
import { ListTransactionsUseCase } from './features/list-transactions/list-transactions.use-case';
import { TransactionsQuery } from './features/list-transactions/transactions.query';
import { UpdateDisplayNameController } from './features/update-display-name/update-display-name.controller';
import { UpdateDisplayNameUseCase } from './features/update-display-name/update-display-name.use-case';
import { UpdateProfileImageController } from './features/update-profile-image/update-profile-image.controller';
import { UpdateProfileImageUseCase } from './features/update-profile-image/update-profile-image.use-case';
import { ProfileImageStorage } from './resources/profile-image/profile-image.storage';
import { ProfileRepository } from './resources/profile/profile.repository';
import { SolanaBalanceReader } from './resources/wallet-balance/solana-balance.reader';

@Module({
  imports: [AuthModule, LoggerModule],
  controllers: [
    UpdateDisplayNameController,
    UpdateProfileImageController,
    GetWalletBalanceController,
    ListTransactionsController,
  ],
  providers: [
    UpdateDisplayNameUseCase,
    UpdateProfileImageUseCase,
    ProfileImageStorage,
    ProfileRepository,
    GetWalletBalanceUseCase,
    SolanaBalanceReader,
    ListTransactionsUseCase,
    TransactionsQuery,
  ],
})
export class UserModule {}
