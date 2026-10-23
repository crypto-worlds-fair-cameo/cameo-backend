import { ApiProperty } from '@nestjs/swagger';
import type { SeasonStatus } from '../../resources/season/season-state';
import type {
  HostedSeasonItem,
  HostedSeasonsPage,
} from './list-hosted-seasons.use-case';

class HostedSeasonResponse implements HostedSeasonItem {
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

  @ApiProperty({ type: 'integer', minimum: 0 })
  participantCount!: number;

  @ApiProperty({ type: String, format: 'uri', nullable: true })
  finalImageUrl!: string | null;
}

/** 개설 시즌 목록의 item과 offset pagination 응답을 문서화한다. */
export class HostedSeasonsResponse implements HostedSeasonsPage {
  @ApiProperty({ type: () => HostedSeasonResponse, isArray: true })
  items!: HostedSeasonResponse[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  total!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50, default: 20 })
  limit!: number;

  @ApiProperty({ type: 'integer', minimum: 0, default: 0 })
  offset!: number;
}
