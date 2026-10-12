import { Module } from '@nestjs/common';
import { LoggerModule } from '../../logging/logger.module';
import { AuthModule } from '../auth/auth.module';
import { UpdateDisplayNameController } from './features/update-display-name/update-display-name.controller';
import { UpdateDisplayNameUseCase } from './features/update-display-name/update-display-name.use-case';
import { UpdateProfileImageController } from './features/update-profile-image/update-profile-image.controller';
import { UpdateProfileImageUseCase } from './features/update-profile-image/update-profile-image.use-case';
import { ProfileImageStorage } from './resources/profile-image/profile-image.storage';
import { ProfileRepository } from './resources/profile/profile.repository';

@Module({
  imports: [AuthModule, LoggerModule],
  controllers: [UpdateDisplayNameController, UpdateProfileImageController],
  providers: [
    UpdateDisplayNameUseCase,
    UpdateProfileImageUseCase,
    ProfileImageStorage,
    ProfileRepository,
  ],
})
export class UserModule {}
