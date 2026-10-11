import {
  getMerkleProof,
  getMerkleRoot,
} from '@metaplex-foundation/mpl-core-candy-machine';
import type { PublicKey } from '@metaplex-foundation/umi';
import { Inject, Injectable } from '@nestjs/common';

export type SeasonNftMerklePassResult = Readonly<{
  merkleRoot: Buffer | null;
  merkleProofs: readonly (readonly (readonly number[])[])[];
}>;

export type SeasonNftMerklePass = (
  keys: readonly PublicKey[],
) => SeasonNftMerklePassResult;

export const SEASON_NFT_MERKLE_PASS = Symbol('SEASON_NFT_MERKLE_PASS');

/** 검증된 SDK로 canonical key 목록의 root와 사용자별 proof를 한 번 계산한다. */
export function calculateSeasonNftMerklePass(
  keys: readonly PublicKey[],
): SeasonNftMerklePassResult {
  const orderedKeys = [...keys];
  return {
    merkleRoot: orderedKeys.length
      ? Buffer.from(getMerkleRoot(orderedKeys))
      : null,
    merkleProofs: orderedKeys.map((key) =>
      getMerkleProof(orderedKeys, key).map((node) => [...node]),
    ),
  };
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function sameArtifacts(
  left: SeasonNftMerklePassResult,
  right: SeasonNftMerklePassResult,
): boolean {
  const rootsMatch =
    left.merkleRoot === null
      ? right.merkleRoot === null
      : right.merkleRoot !== null && left.merkleRoot.equals(right.merkleRoot);
  return (
    rootsMatch &&
    left.merkleProofs.length === right.merkleProofs.length &&
    left.merkleProofs.every((proof, proofIndex) => {
      const compared = right.merkleProofs[proofIndex];
      return (
        compared !== undefined &&
        proof.length === compared.length &&
        proof.every((node, nodeIndex) =>
          sameBytes(node, compared[nodeIndex] ?? []),
        )
      );
    })
  );
}

/** 동일 Merkle 계산을 두 번 실행해 immutable 저장 전에 root와 모든 proof byte를 대조한다. */
@Injectable()
export class SeasonNftMerkleArtifacts {
  constructor(
    @Inject(SEASON_NFT_MERKLE_PASS)
    private readonly calculatePass: SeasonNftMerklePass,
  ) {}

  build(keys: readonly PublicKey[]): SeasonNftMerklePassResult {
    const first = this.calculatePass([...keys]);
    const second = this.calculatePass([...keys]);
    if (!sameArtifacts(first, second))
      throw new Error('Season NFT Merkle artifacts are not deterministic.');
    return first;
  }
}
