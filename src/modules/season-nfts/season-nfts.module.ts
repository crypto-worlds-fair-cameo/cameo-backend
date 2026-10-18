import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClaimRepository } from './resources/claim/claim.repository';
import { NftUploadRepository } from './resources/nft-media/nft-upload.repository';
import {
  NFT_MEDIA_GATEWAY_FETCH,
  TurboMediaPublisher,
} from './resources/nft-media/turbo-media-publisher';
import {
  TurboMediaTransport,
  TurboSdkMediaTransport,
} from './resources/nft-media/turbo-sdk-media-transport';
import { NftTransactionRepository } from './resources/solana-nft/nft-transaction.repository';
import {
  NftChainRpc,
  NftClaimEffectRpc,
  NftDispatchRepository,
  NftTransactionDispatcher,
} from './resources/solana-nft/nft-transaction-dispatcher';
import {
  NftWorker,
  NftWorkerQueue,
  NftWorkerStartup,
} from './resources/nft-worker/nft-worker';
import { NftWorkerConfig } from './resources/nft-worker/nft-worker-config';
import {
  NftClaimBuildOperationProvider,
  NftClaimReceiptLookup,
  NftClaimReconciliation,
  NftReleaseChainOperationProvider,
  NftRuntimeQueue,
} from './resources/nft-worker/nft-runtime-queue';
import { SeasonNftRepository } from './resources/season-nft/season-nft.repository';
import { CanvasModule } from '../canvas/canvas.module';
import { PrepareSeasonNftUseCase } from './features/prepare-season-nft/prepare-season-nft.use-case';
import { SeasonNftCandidatesQuery } from './features/prepare-season-nft/season-nft-candidates.query';
import {
  calculateSeasonNftMerklePass,
  SEASON_NFT_MERKLE_PASS,
  SeasonNftMerkleArtifacts,
} from './features/prepare-season-nft/season-nft-merkle-artifacts';
import { PreparationKeyStore } from './resources/solana-nft/preparation-key-store';
import {
  SEASON_NFT_RPC_FETCH,
  SeasonNftRpcStartupValidator,
  SeasonNftRpcTransport,
  SeasonNftUmiFactory,
  SeasonReleaseChain,
  SolanaJsonRpcTransport,
  SolanaNftChainRpc,
} from './resources/solana-nft/season-release-chain';
import { GetSeasonNftController } from './features/get-season-nft/get-season-nft.controller';
import { GetSeasonNftQuery } from './features/get-season-nft/get-season-nft.query';
import { GetSeasonNftUseCase } from './features/get-season-nft/get-season-nft.use-case';
import { ListSeasonHoldersController } from './features/list-season-holders/list-season-holders.controller';
import { ListSeasonHoldersQuery } from './features/list-season-holders/list-season-holders.query';
import { ListSeasonHoldersUseCase } from './features/list-season-holders/list-season-holders.use-case';
import { CreateClaimAttemptController } from './features/create-claim-attempt/create-claim-attempt.controller';
import { CreateClaimAttemptUseCase } from './features/create-claim-attempt/create-claim-attempt.use-case';
import { GetClaimAttemptController } from './features/get-claim-attempt/get-claim-attempt.controller';
import { GetClaimAttemptUseCase } from './features/get-claim-attempt/get-claim-attempt.use-case';
import { SubmitClaimTransactionController } from './features/submit-claim-transaction/submit-claim-transaction.controller';
import { RequestSeasonNftMintController } from './features/request-season-nft-mint/request-season-nft-mint.controller';
import { RequestSeasonNftMintUseCase } from './features/request-season-nft-mint/request-season-nft-mint.use-case';
import { SeasonNftMintQuery } from './features/request-season-nft-mint/season-nft-mint.query';
import { SubmitClaimTransactionUseCase } from './features/submit-claim-transaction/submit-claim-transaction.use-case';
import {
  SeasonClaimChain,
  SeasonClaimEffectInspector,
  SeasonClaimReceiptLookup,
} from './resources/solana-nft/season-claim-chain';
import { ReconcileNftTransactionsUseCase } from './features/reconcile-nft-transactions/reconcile-nft-transactions.use-case';

/** NFT 모듈은 비활성 boot의 무 I/O 계약과 활성 worker의 genesis 선검증 provider를 함께 연결한다. */
@Module({
  imports: [AuthModule, CanvasModule],
  controllers: [
    GetSeasonNftController,
    ListSeasonHoldersController,
    CreateClaimAttemptController,
    GetClaimAttemptController,
    SubmitClaimTransactionController,
    RequestSeasonNftMintController,
  ],
  providers: [
    CreateClaimAttemptUseCase,
    GetClaimAttemptUseCase,
    SubmitClaimTransactionUseCase,
    RequestSeasonNftMintUseCase,
    SeasonNftMintQuery,
    ReconcileNftTransactionsUseCase,
    {
      provide: NftClaimReconciliation,
      useExisting: ReconcileNftTransactionsUseCase,
    },
    GetSeasonNftQuery,
    GetSeasonNftUseCase,
    ListSeasonHoldersQuery,
    ListSeasonHoldersUseCase,
    SeasonNftRepository,
    ClaimRepository,
    NftTransactionRepository,
    { provide: NftDispatchRepository, useExisting: NftTransactionRepository },
    SolanaJsonRpcTransport,
    { provide: SeasonNftRpcTransport, useExisting: SolanaJsonRpcTransport },
    { provide: SEASON_NFT_RPC_FETCH, useValue: globalThis.fetch },
    SolanaNftChainRpc,
    { provide: NftChainRpc, useExisting: SolanaNftChainRpc },
    NftTransactionDispatcher,
    NftUploadRepository,
    TurboSdkMediaTransport,
    { provide: TurboMediaTransport, useExisting: TurboSdkMediaTransport },
    { provide: NFT_MEDIA_GATEWAY_FETCH, useValue: globalThis.fetch },
    TurboMediaPublisher,
    SeasonNftCandidatesQuery,
    {
      provide: SEASON_NFT_MERKLE_PASS,
      useValue: calculateSeasonNftMerklePass,
    },
    SeasonNftMerkleArtifacts,
    PrepareSeasonNftUseCase,
    NftWorkerConfig,
    PreparationKeyStore,
    SeasonNftUmiFactory,
    SeasonReleaseChain,
    {
      provide: NftReleaseChainOperationProvider,
      useExisting: SeasonReleaseChain,
    },
    SeasonNftRpcStartupValidator,
    { provide: NftWorkerStartup, useExisting: SeasonNftRpcStartupValidator },
    SeasonClaimChain,
    SeasonClaimEffectInspector,
    { provide: NftClaimEffectRpc, useExisting: SeasonClaimEffectInspector },
    {
      provide: NftClaimBuildOperationProvider,
      useExisting: SeasonClaimChain,
    },
    SeasonClaimReceiptLookup,
    {
      provide: NftClaimReceiptLookup,
      useExisting: SeasonClaimReceiptLookup,
    },
    NftRuntimeQueue,
    { provide: NftWorkerQueue, useExisting: NftRuntimeQueue },
    NftWorker,
  ],
  exports: [
    PrepareSeasonNftUseCase,
    SeasonNftCandidatesQuery,
    NftTransactionDispatcher,
    NftWorkerQueue,
    NftReleaseChainOperationProvider,
    NftClaimBuildOperationProvider,
    NftClaimReceiptLookup,
  ],
})
export class SeasonNftsModule {}
