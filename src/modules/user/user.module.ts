import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UpdateDisplayNameController } from './features/update-display-name/update-display-name.controller';
import { UpdateDisplayNameUseCase } from './features/update-display-name/update-display-name.use-case';
import { ProfileRepository } from './resources/profile/profile.repository';

@Module({
  imports: [AuthModule],
  controllers: [UpdateDisplayNameController],
  providers: [UpdateDisplayNameUseCase, ProfileRepository],
})
export class UserModule {}
