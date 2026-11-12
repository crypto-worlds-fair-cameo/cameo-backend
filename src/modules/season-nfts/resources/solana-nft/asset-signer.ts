import { createHmac } from 'node:crypto';
import {
  createSignerFromKeypair,
  type Keypair,
  type Signer,
  type Umi,
} from '@metaplex-foundation/umi';
import type { SeasonNftNetwork } from '../season-nft/season-nft';

/** 새 NFT 주소 하나를 정하는 값. 같은 준비 거래에서는 언제나 같은 주소가 나온다. */
export type AssetSignerScope = Readonly<{
  network: SeasonNftNetwork;
  releaseId: string;
  operationKey: string;
  blockhash: string;
}>;

/**
 * 발행할 NFT의 새 주소 열쇠를 서비스 열쇠에서 유도한다.
 * 지갑이 먼저 서명한 뒤 서버가 이 열쇠로 서명해야 하므로, 저장하지 않아도 접수할 때 같은 열쇠를 다시 만들 수 있어야 한다.
 * 이 열쇠는 NFT 계정을 만드는 그 한 번만 쓰이고 그 뒤로는 아무 권한이 없다.
 */
export function deriveAssetSigner(
  umi: Pick<Umi, 'eddsa'>,
  service: Keypair,
  scope: AssetSignerScope,
): Signer {
  const seed = createHmac('sha256', service.secretKey)
    .update(
      [
        'cameo-nft-asset-v1',
        scope.network,
        scope.releaseId,
        scope.operationKey,
        scope.blockhash,
      ].join('\n'),
    )
    .digest();
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(seed));
}
