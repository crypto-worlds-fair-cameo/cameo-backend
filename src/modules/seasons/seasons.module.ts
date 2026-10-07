import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CanvasModule } from '../canvas/canvas.module';
import { CreateSeasonController } from './features/create-season/create-season.controller';
import { CreateSeasonUseCase } from './features/create-season/create-season.use-case';
import { CancelSeasonController } from './features/cancel-season/cancel-season.controller';
import { CancelSeasonUseCase } from './features/cancel-season/cancel-season.use-case';
import { EndSeasonController } from './features/end-season/end-season.controller';
import { EndSeasonUseCase } from './features/end-season/end-season.use-case';
import { GetSeasonController } from './features/get-season/get-season.controller';
import { GetSeasonUseCase } from './features/get-season/get-season.use-case';
import { JoinSeasonController } from './features/join-season/join-season.controller';
import { JoinSeasonUseCase } from './features/join-season/join-season.use-case';
import { ListSeasonsController } from './features/list-seasons/list-seasons.controller';
import { ListSeasonsUseCase } from './features/list-seasons/list-seasons.use-case';
import { SeasonRepository } from './resources/season/season.repository';

@Module({
  imports: [AuthModule, CanvasModule],
  controllers: [
    CreateSeasonController,
    CancelSeasonController,
    EndSeasonController,
    GetSeasonController,
    JoinSeasonController,
    ListSeasonsController,
  ],
  providers: [
    CreateSeasonUseCase,
    CancelSeasonUseCase,
    EndSeasonUseCase,
    GetSeasonUseCase,
    JoinSeasonUseCase,
    ListSeasonsUseCase,
    SeasonRepository,
  ],
})
export class SeasonsModule {}
