import { ApiProperty } from '@nestjs/swagger';
import type {
  SeasonNftClaimView,
  SeasonNftView,
} from '../../resources/season-nft/season-nft-view';

export class SeasonNftClaimResponse implements SeasonNftClaimView {
  @ApiProperty({ enum: ['ELIGIBLE', 'NOT_PARTICIPANT', 'NO_VALID_STROKE'] })
  eligibility!: SeasonNftClaimView['eligibility'];

  @ApiProperty({ enum: ['UNCLAIMED', 'PROCESSING', 'CLAIMED'] })
  state!: SeasonNftClaimView['state'];

  @ApiProperty({ type: String, nullable: true })
  walletAddress!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  activeAttemptId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  assetAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  signature!: string | null;

  @ApiProperty({ enum: ['NONE', 'RESOLVING', 'VERIFIED'] })
  receiptState!: SeasonNftClaimView['receiptState'];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  claimedAt!: string | null;
}

/** GET 시즌 NFT 응답의 enum과 nullable 필드를 Swagger 계약으로 고정한다. */
export class SeasonNftResponse implements SeasonNftView {
  @ApiProperty({ format: 'uuid' })
  seasonId!: string;

  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: SeasonNftView['network'];

  @ApiProperty({
    enum: ['WAITING_FOR_END', 'PREPARING', 'READY', 'EMPTY', 'UNAVAILABLE'],
  })
  availability!: SeasonNftView['availability'];

  @ApiProperty({
    type: String,
    enum: [
      'CANCELLED',
      'FORCE_ENDED',
      'FEATURE_DISABLED',
      'TOO_MANY_CONTRIBUTORS',
    ],
    nullable: true,
    description:
      'TOO_MANY_CONTRIBUTORS는 유효 획 참여자가 100명을 넘어 NFT를 발행하지 않는 정원 무제한 시즌입니다.',
  })
  reason!: SeasonNftView['reason'];

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ type: String, format: 'uri', nullable: true })
  imageUrl!: string | null;

  @ApiProperty({ type: String, format: 'uri', nullable: true })
  metadataUri!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, nullable: true })
  eligibleCount!: number | null;

  @ApiProperty({ type: () => SeasonNftClaimResponse })
  claim!: SeasonNftClaimResponse;
}
