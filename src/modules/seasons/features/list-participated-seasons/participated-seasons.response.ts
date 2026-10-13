import { ApiProperty } from '@nestjs/swagger';
import type { SeasonStatus } from '../../resources/season/season-state';
import type {
  ParticipatedSeasonItem,
  ParticipatedSeasonsPage,
} from './list-participated-seasons.use-case';

class ParticipatedSeasonClaimResponse {
  @ApiProperty({ enum: ['ELIGIBLE', 'NOT_PARTICIPANT', 'NO_VALID_STROKE'] })
  eligibility!: ParticipatedSeasonItem['nft']['claim']['eligibility'];

  @ApiProperty({ enum: ['UNCLAIMED', 'PROCESSING', 'CLAIMED'] })
  state!: ParticipatedSeasonItem['nft']['claim']['state'];

  @ApiProperty({ type: String, nullable: true })
  walletAddress!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  activeAttemptId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  assetAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  signature!: string | null;

  @ApiProperty({ enum: ['NONE', 'RESOLVING', 'VERIFIED'] })
  receiptState!: ParticipatedSeasonItem['nft']['claim']['receiptState'];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  claimedAt!: string | null;
}

class ParticipatedSeasonNftResponse {
  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: ParticipatedSeasonItem['nft']['network'];

  @ApiProperty({
    enum: ['WAITING_FOR_END', 'PREPARING', 'READY', 'EMPTY', 'UNAVAILABLE'],
  })
  availability!: ParticipatedSeasonItem['nft']['availability'];

  @ApiProperty({
    type: String,
    enum: [
      'CANCELLED',
      'FORCE_ENDED',
      'FEATURE_DISABLED',
      'TOO_MANY_CONTRIBUTORS',
    ],
    nullable: true,
  })
  reason!: ParticipatedSeasonItem['nft']['reason'];

  @ApiProperty({ type: () => ParticipatedSeasonClaimResponse })
  claim!: ParticipatedSeasonClaimResponse;
}

class ParticipatedSeasonResponse implements ParticipatedSeasonItem {
  @ApiProperty({ format: 'uuid' })
  seasonId!: string;

  @ApiProperty({ minLength: 1, maxLength: 50 })
  title!: string;

  @ApiProperty({ enum: ['scheduled', 'active', 'ended', 'cancelled'] })
  lifecycleStatus!: SeasonStatus;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ format: 'date-time' })
  joinedAt!: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  ownStrokeCount!: number;

  @ApiProperty({ type: String, format: 'uri', nullable: true })
  finalImageUrl!: string | null;

  @ApiProperty({ type: () => ParticipatedSeasonNftResponse })
  nft!: ParticipatedSeasonNftResponse;
}

/** 참여 시즌 목록의 정확한 item과 offset pagination 응답을 문서화한다. */
export class ParticipatedSeasonsResponse implements ParticipatedSeasonsPage {
  @ApiProperty({ type: () => ParticipatedSeasonResponse, isArray: true })
  items!: ParticipatedSeasonResponse[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  total!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50, default: 20 })
  limit!: number;

  @ApiProperty({ type: 'integer', minimum: 0, default: 0 })
  offset!: number;
}
