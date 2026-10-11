import { ApiProperty } from '@nestjs/swagger';

class ClaimAttemptTransactionResponse {
  @ApiProperty({ format: 'uuid' }) transactionId!: string;
  @ApiProperty({ description: 'Canonical padded Base64 legacy transaction.' })
  serializedTransactionBase64!: string;
  @ApiProperty({ example: '12345' }) lastValidBlockHeight!: string;
  @ApiProperty({ example: '10000' }) estimatedCostLamports!: string;
  @ApiProperty({ format: 'date-time' }) estimatedAt!: string;
}

export class ClaimAttemptResponse {
  @ApiProperty({ format: 'uuid' }) attemptId!: string;
  @ApiProperty({
    enum: [
      'QUEUED',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'CONFIRMING',
      'SUCCEEDED',
      'EXPIRED',
      'FAILED',
    ],
  })
  state!: string;
  @ApiProperty({ enum: ['ALLOWLIST_PROOF', 'MINT'] }) step!: string;
  @ApiProperty() walletAddress!: string;
  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] }) network!: string;
  @ApiProperty({ type: ClaimAttemptTransactionResponse, nullable: true })
  transaction!: ClaimAttemptTransactionResponse | null;
  @ApiProperty({ nullable: true }) errorCode!: string | null;
  @ApiProperty() retryable!: boolean;
}
