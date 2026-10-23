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
import { HostedSeasonsQuery } from './features/list-hosted-seasons/hosted-seasons.query';
import { ListHostedSeasonsController } from './features/list-hosted-seasons/list-hosted-seasons.controller';
import { ListHostedSeasonsUseCase } from './features/list-hosted-seasons/list-hosted-seasons.use-case';
import { ListParticipatedSeasonsController } from './features/list-participated-seasons/list-participated-seasons.controller';
import { ListParticipatedSeasonsUseCase } from './features/list-participated-seasons/list-participated-seasons.use-case';
import { ParticipatedSeasonsQuery } from './features/list-participated-seasons/participated-seasons.query';
import { PaySeasonEntryController } from './features/pay-season-entry/pay-season-entry.controller';
import { PaySeasonEntryUseCase } from './features/pay-season-entry/pay-season-entry.use-case';
import { SeasonRepository } from './resources/season/season.repository';
import { SeasonEntryChain } from './resources/season-entry-payment/season-entry-chain';
import { SeasonEntryPaymentRepository } from './resources/season-entry-payment/season-entry-payment.repository';

@Module({
  imports: [AuthModule, CanvasModule],
  controllers: [
    CreateSeasonController,
    CancelSeasonController,
    EndSeasonController,
    ListParticipatedSeasonsController,
    ListHostedSeasonsController,
    GetSeasonController,
    JoinSeasonController,
    PaySeasonEntryController,
    ListSeasonsController,
  ],
  providers: [
    CreateSeasonUseCase,
    CancelSeasonUseCase,
    EndSeasonUseCase,
    ListParticipatedSeasonsUseCase,
    ParticipatedSeasonsQuery,
    ListHostedSeasonsUseCase,
    HostedSeasonsQuery,
    GetSeasonUseCase,
    JoinSeasonUseCase,
    PaySeasonEntryUseCase,
    ListSeasonsUseCase,
    SeasonRepository,
    SeasonEntryChain,
    SeasonEntryPaymentRepository,
  ],
})
export class SeasonsModule {}
