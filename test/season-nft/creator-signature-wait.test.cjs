const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CREATOR_MINT_BATCH_SIZE,
  CREATOR_SIGNATURE_WAIT_MS,
  creatorApprovalStep,
  creatorWalletApprovalCount,
  shouldRefreshCreatorTransaction,
} = require('../../dist/modules/season-nfts/resources/solana-nft/creator-signature-wait');

describe('creator signature wait', () => {
  it('refreshes an expired transaction only while the creator still has the mint screen open', () => {
    const now = 1_000_000;
    assert.equal(
      shouldRefreshCreatorTransaction({ now, lastSeenAt: null }),
      false,
    );
    assert.equal(
      shouldRefreshCreatorTransaction({
        now,
        lastSeenAt: now - CREATOR_SIGNATURE_WAIT_MS,
      }),
      false,
    );
    assert.equal(
      shouldRefreshCreatorTransaction({
        now,
        lastSeenAt: now - CREATOR_SIGNATURE_WAIT_MS + 1,
      }),
      true,
    );
  });

  it('counts one Phantom approval per batch of creator NFTs', () => {
    assert.equal(CREATOR_MINT_BATCH_SIZE, 8);
    assert.equal(
      creatorWalletApprovalCount({
        allocation: 1,
        setupCount: 3,
        paysStorage: false,
      }),
      4,
    );
    assert.equal(
      creatorWalletApprovalCount({
        allocation: 8,
        setupCount: 3,
        paysStorage: true,
      }),
      5,
    );
    assert.equal(
      creatorWalletApprovalCount({
        allocation: 9,
        setupCount: 3,
        paysStorage: false,
      }),
      5,
    );
  });

  it('numbers the confirmation the wallet is about to see', () => {
    const common = { allocation: 1, mintedCount: 0, setupCount: 3 };
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: true,
        pendingKind: 'SETUP_STORAGE_FUND',
      }),
      1,
    );
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: true,
        pendingKind: 'SETUP_COLLECTION',
      }),
      2,
    );
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: true,
        pendingKind: 'SETUP_MACHINE',
      }),
      3,
    );
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: true,
        pendingKind: 'SETUP_CREATOR_MINT',
      }),
      4,
    );
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: true,
        pendingKind: 'SETUP_LOCK',
      }),
      5,
    );
    // 연습망은 저장 비용 확인이 없다.
    assert.equal(
      creatorApprovalStep({
        ...common,
        paysStorage: false,
        pendingKind: 'SETUP_COLLECTION',
      }),
      1,
    );
    // 개설자 NFT 9개는 확인 두 번이고, 8개가 끝난 뒤가 두 번째다.
    assert.equal(
      creatorApprovalStep({
        allocation: 9,
        mintedCount: 8,
        setupCount: 3,
        paysStorage: false,
        pendingKind: 'SETUP_CREATOR_MINT',
      }),
      4,
    );
    assert.equal(
      creatorApprovalStep({
        allocation: 9,
        mintedCount: 8,
        setupCount: 3,
        paysStorage: false,
        pendingKind: 'SETUP_LOCK',
      }),
      5,
    );
  });
});
