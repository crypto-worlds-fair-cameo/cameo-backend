const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CREATOR_MINT_BATCH_SIZE,
  CREATOR_SIGNATURE_WAIT_MS,
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
});
