import { Injectable } from '@nestjs/common';
import type { Signer } from '@metaplex-foundation/umi';
import type { SeasonNftNetwork } from '../season-nft/season-nft';
import { deriveAssetSigner, type AssetSignerScope } from './asset-signer';
import { PreparationKeyStore } from './preparation-key-store';
import { SeasonNftUmiFactory } from './season-release-chain';
import {
  completeSignedTransaction,
  type ValidatedSignedClaimTransaction,
  type WalletSignedTransaction,
} from './signed-transaction-validator';

/**
 * 지갑이 먼저 서명한 거래에 서버 서명을 채운다.
 * 서버가 먼저 서명해 둔 거래는 Phantom이 안전 확인을 붙일 수 없어 위험한 요청으로 막는다.
 */
@Injectable()
export class NftServerCosigner {
  constructor(
    private readonly umiFactory: SeasonNftUmiFactory,
    private readonly keys: PreparationKeyStore,
  ) {}

  /** 준비 거래에 넣을 새 NFT 주소. 접수할 때 complete가 같은 열쇠를 다시 만든다. */
  async assetSigner(scope: AssetSignerScope): Promise<Signer> {
    const { umi, service } = await this.umiFactory.create();
    return deriveAssetSigner(umi, service, scope);
  }

  /** 비어 있는 서명 칸을 서비스·컬렉션·발행 장치·NFT 열쇠로 채운 완성본을 돌려준다. 열쇠는 채울 칸이 있을 때만 읽는다. */
  async complete(
    input: Readonly<{
      network: SeasonNftNetwork;
      releaseId: string;
      operationKey: string;
      collectionAddress: string | null;
      candyMachineAddress: string | null;
      validated: WalletSignedTransaction;
    }>,
  ): Promise<ValidatedSignedClaimTransaction> {
    const { validated } = input;
    if (validated.missingSigners.length === 0) {
      return completeSignedTransaction(validated, []);
    }
    const { umi, service } = await this.umiFactory.create();
    const asset = deriveAssetSigner(umi, service, {
      network: input.network,
      releaseId: input.releaseId,
      operationKey: input.operationKey,
      blockhash: validated.transaction.message.blockhash,
    });
    const signers: Signer[] = [];
    for (const address of validated.missingSigners) {
      if (address === String(service.publicKey)) {
        signers.push(service);
      } else if (address === String(asset.publicKey)) {
        signers.push(asset);
      } else if (
        address === input.collectionAddress ||
        address === input.candyMachineAddress
      ) {
        const key = await this.keys.loadOrCreate({
          network: input.network,
          releaseId: input.releaseId,
          kind: address === input.collectionAddress ? 'collection' : 'machine',
          expectedPublicKey: address,
          umi,
        });
        signers.push(key.signer);
      }
      // 그 밖의 주소는 서버가 대신 서명할 수 없으므로 completeSignedTransaction이 거절한다.
    }
    return completeSignedTransaction(validated, signers);
  }
}
