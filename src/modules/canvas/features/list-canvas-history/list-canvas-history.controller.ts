import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { CanvasErrorCodes } from '../../resources/canvas-definition/canvas.error-codes';
import {
  ListCanvasHistoryUseCase,
  MAX_CANVAS_HISTORY_CURSOR_LENGTH,
  type CanvasHistoryPage,
} from './list-canvas-history.use-case';

export class CanvasHistoryItemResponse {
  @ApiProperty({ format: 'uuid', description: '스냅샷 ID.' })
  id!: string;

  @ApiProperty({ format: 'uri', description: '스냅샷 PNG 공개 URL.' })
  imageUrl!: string;

  @ApiProperty({ type: 'integer', minimum: 1, description: '이미지 너비(px).' })
  width!: number;

  @ApiProperty({ type: 'integer', minimum: 1, description: '이미지 높이(px).' })
  height!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'UTC 캡처 시각.',
  })
  capturedAt!: string;

  @ApiProperty({ description: '시즌 종료 후 확정한 최종 스냅샷 여부.' })
  isFinal!: boolean;
}

export class CanvasHistoryResponse {
  @ApiProperty({ type: () => CanvasHistoryItemResponse, isArray: true })
  items!: CanvasHistoryItemResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: '다음 페이지 요청에 그대로 전달할 불투명 커서.',
  })
  nextCursor!: string | null;

  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
}

/** 내부 Date 값을 HTTP date-time 문자열로 변환하고 공개 필드만 선택한다. */
function toCanvasHistoryResponse(
  page: CanvasHistoryPage,
): CanvasHistoryResponse {
  return {
    items: page.items.map((item) => ({
      id: item.id,
      imageUrl: item.imageUrl,
      width: item.width,
      height: item.height,
      capturedAt: item.capturedAt.toISOString(),
      isFinal: item.isFinal,
    })),
    nextCursor: page.nextCursor,
    hasNext: page.hasNext,
  };
}

function parsePositiveInteger(value: unknown): unknown {
  // 10진 양의 정수 정규형만 number로 바꾸고 나머지는 validator가 거절하게 둔다.
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return value;
  const parsed = Number(value);
  // JS 안전 정수 범위를 넘은 문자열은 원문을 유지해 정수 검증을 실패시킨다.
  return Number.isSafeInteger(parsed) ? parsed : value;
}

class ListCanvasHistoryQuery {
  @Transform(({ value }) => parsePositiveInteger(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_CANVAS_HISTORY_CURSOR_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

@ApiTags('Canvas')
@Controller('canvases/:canvasId/history')
export class ListCanvasHistoryController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly listHistory: ListCanvasHistoryUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  /** 선택 세션과 검증한 커서를 전달하고 스냅샷 날짜를 ISO 문자열로 반환한다. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '캔버스 히스토리 조회',
    description:
      '메인·공개 시즌 캔버스의 READY 스냅샷을 캡처 시각과 ID의 내림차순으로 조회합니다. 취소된 시즌은 개설자만 조회할 수 있습니다. 잘못되거나 사용할 수 없는 세션은 익명으로 처리합니다. nextCursor는 해석하거나 수정하지 말고 다음 요청에 그대로 전달합니다.',
    security: [{}, { session: [] }],
  })
  @ApiParam({
    name: 'canvasId',
    format: 'uuid',
    description: '조회할 메인 또는 시즌 캔버스 ID.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: '페이지당 스냅샷 수.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CANVAS_HISTORY_CURSOR_LENGTH,
    },
    description: '이전 응답의 nextCursor.',
  })
  @ApiSuccessResponse(CanvasHistoryResponse, {
    description: '최신순 스냅샷과 다음 페이지 커서입니다.',
  })
  @ApiErrorResponses([CanvasErrorCodes.CanvasNotFound], {
    rateLimited: false,
  })
  async list(
    @Param('canvasId', new ParseUUIDPipe({ version: '4' })) canvasId: string,
    @Query() query: ListCanvasHistoryQuery,
    @Req() request: Request,
  ): Promise<CanvasHistoryResponse> {
    const page = await this.listHistory.execute(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      { canvasId, limit: query.limit, cursor: query.cursor },
    );
    return toCanvasHistoryResponse(page);
  }
}
