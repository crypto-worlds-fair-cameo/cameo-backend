import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';

export type SeasonEntryPaymentStatus =
  'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

export type SeasonEntryPaymentRecord = Readonly<{
  id: string;
  seasonId: string;
  userId: string;
  walletAccountId: string;
  payerAddress: string;
  recipientAddress: string;
  network: SeasonNftNetwork;
  lamports: string;
  status: SeasonEntryPaymentStatus;
  preparedTransaction: Buffer;
  messageHash: string;
  signature: string | null;
  lastValidBlockHeight: bigint;
  expiresAt: Date;
}>;

export type SeasonEntryPaymentView = Readonly<{
  paymentId: string;
  seasonId: string;
  status: SeasonEntryPaymentStatus;
  network: SeasonNftNetwork;
  lamports: string;
  payerAddress: string;
  recipientAddress: string;
  serializedTransactionBase64: string | null;
  signature: string | null;
  expiresAt: string;
}>;

/** 서명 대기 중인 결제에만 지갑에 넘길 미서명 거래를 포함한다. */
export function toSeasonEntryPaymentView(
  payment: SeasonEntryPaymentRecord,
): SeasonEntryPaymentView {
  return {
    paymentId: payment.id,
    seasonId: payment.seasonId,
    status: payment.status,
    network: payment.network,
    lamports: payment.lamports,
    payerAddress: payment.payerAddress,
    recipientAddress: payment.recipientAddress,
    serializedTransactionBase64:
      payment.status === 'AWAITING_SIGNATURE'
        ? payment.preparedTransaction.toString('base64')
        : null,
    signature: payment.signature,
    expiresAt: payment.expiresAt.toISOString(),
  };
}
