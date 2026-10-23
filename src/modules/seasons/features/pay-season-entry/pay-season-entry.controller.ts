import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AllConfigType } from '../../../../config/config.type';
import { AuthErrorCodes } from '../../../../errors/auth.error-codes';
import {
  ApiErrorResponses,
  ApiSuccessResponse,
} from '../../../../http/swagger-response';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { SeasonErrorCodes } from '../../resources/season/season.error-codes';
import type {
  SeasonEntryPaymentStatus,
  SeasonEntryPaymentView,
} from '../../resources/season-entry-payment/season-entry-payment';
import { PaySeasonEntryUseCase } from './pay-season-entry.use-case';

class SubmitSeasonEntryTransactionBody {
  @ApiProperty({
    maxLength: 1644,
    description: '지갑이 서명한 canonical padded Base64 legacy 거래.',
  })
  @IsString()
  @MaxLength(1644)
  @Matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  signedTransactionBase64!: string;
}

class SeasonEntryPaymentResponse implements SeasonEntryPaymentView {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ format: 'uuid' })
  seasonId!: string;

  @ApiProperty({
    enum: ['AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED'],
    description:
      'CONFIRMED이면 참가가 기록되었습니다. FAILED·EXPIRED이면 새 결제를 시작해야 합니다.',
  })
  status!: SeasonEntryPaymentStatus;

  @ApiProperty({ enum: ['devnet', 'mainnet-beta'] })
  network!: SeasonEntryPaymentView['network'];

  @ApiProperty({ example: '10000000', description: 'lamports 10진 문자열.' })
  lamports!: string;

  @ApiProperty({ description: '입장료를 보내는 참가자 지갑 주소.' })
  payerAddress!: string;

  @ApiProperty({ description: '입장료를 받는 개설자 지갑 주소.' })
  recipientAddress!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'AWAITING_SIGNATURE일 때만 제공하는 미서명 legacy 거래 Base64. 지갑에서 서명만 하고 내용을 바꾸지 않습니다.',
  })
  serializedTransactionBase64!: string | null;

  @ApiProperty({ type: String, nullable: true })
  signature!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: '서명 대기 결제의 서버 기한.',
  })
  expiresAt!: string;
}

@ApiTags('Seasons')
@Controller('seasons/:id/entry-payments')
export class PaySeasonEntryController {
  private readonly cookies: ReturnType<typeof authCookies>;

  constructor(
    private readonly payEntry: PaySeasonEntryUseCase,
    config: ConfigService<AllConfigType>,
  ) {
    this.cookies = authCookies(
      config.getOrThrow('app.nodeEnv', { infer: true }),
    );
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 입장료 결제 준비',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 진행 중인 유료 시즌에 개설자 지갑으로 입장료를 보내는 미서명 거래를 만들고 결제가 끝날 때까지 정원 한 자리를 예약합니다. 서명 대기·제출 중인 결제가 있으면 새로 만들지 않고 그 결제를 반환합니다. 서명 대기 결제는 60초 뒤 만료됩니다. 입장료는 환불하지 않습니다. 본문은 없습니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: '유료 시즌 ID.' })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(SeasonEntryPaymentResponse, {
    description: '서명할 거래 또는 진행 중인 결제를 반환합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthOriginNotAllowed,
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonNotFound,
      SeasonErrorCodes.SeasonStateConflict,
      SeasonErrorCodes.SeasonCapacityReached,
      SeasonErrorCodes.SeasonEntryFeeNotRequired,
      SeasonErrorCodes.SeasonEntryFeeUnavailable,
    ],
    { rateLimited: false },
  )
  async prepare(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<SeasonEntryPaymentResponse> {
    return this.payEntry.prepare(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      id,
    );
  }

  @Post(':paymentId/transaction')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '서명한 시즌 입장료 거래 제출',
    description:
      '로그인 세션 쿠키와 허용된 Origin이 필요합니다. 결제를 준비한 지갑으로 로그인한 상태여야 합니다. 서명 거래가 준비 거래와 같은지 검증한 뒤 Solana에 전송하고 SUBMITTED 결제를 반환합니다. 확정 여부는 결제 조회 API로 확인합니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: '유료 시즌 ID.' })
  @ApiParam({ name: 'paymentId', format: 'uuid' })
  @ApiHeader({
    name: 'Origin',
    required: true,
    description: '허용된 요청 출처. 브라우저가 자동 설정합니다.',
    schema: { type: 'string', format: 'uri' },
  })
  @ApiCookieAuth('session')
  @ApiBody({ type: SubmitSeasonEntryTransactionBody, required: true })
  @ApiSuccessResponse(SeasonEntryPaymentResponse, {
    description: '제출된 결제를 반환합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthOriginNotAllowed,
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonParticipationWalletMismatch,
      SeasonErrorCodes.SeasonEntryPaymentNotFound,
      SeasonErrorCodes.SeasonEntryPaymentInvalidState,
      SeasonErrorCodes.SeasonEntryPaymentExpired,
      SeasonErrorCodes.SeasonEntryTransactionInvalid,
      SeasonErrorCodes.SeasonEntryPaymentFailed,
      SeasonErrorCodes.SeasonEntryFeeUnavailable,
    ],
    { rateLimited: false },
  )
  async submit(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
    @Body() body: SubmitSeasonEntryTransactionBody,
    @Req() request: Request,
  ): Promise<SeasonEntryPaymentResponse> {
    return this.payEntry.submit(
      request.get('Origin'),
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      {
        seasonId: id,
        paymentId,
        signedTransactionBase64: body.signedTransactionBase64,
      },
    );
  }

  @Get(':paymentId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '시즌 입장료 결제 상태 조회',
    description:
      '로그인 세션 쿠키가 필요합니다. 제출된 거래의 체인 상태를 확인해 확정되면 참가를 기록하고 CONFIRMED를 반환합니다. 체인 실패는 FAILED, blockhash 만료는 EXPIRED입니다.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: '유료 시즌 ID.' })
  @ApiParam({ name: 'paymentId', format: 'uuid' })
  @ApiCookieAuth('session')
  @ApiSuccessResponse(SeasonEntryPaymentResponse, {
    description: '최신 결제 상태를 반환합니다.',
  })
  @ApiErrorResponses(
    [
      AuthErrorCodes.AuthSessionInvalid,
      AuthErrorCodes.AuthUserUnavailable,
      SeasonErrorCodes.SeasonNotFound,
      SeasonErrorCodes.SeasonEntryPaymentNotFound,
      SeasonErrorCodes.SeasonEntryFeeUnavailable,
    ],
    { rateLimited: false },
  )
  async refresh(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
    @Req() request: Request,
  ): Promise<SeasonEntryPaymentResponse> {
    return this.payEntry.refresh(
      readAuthCookie(request.headers.cookie, this.cookies.sessionName),
      { seasonId: id, paymentId },
    );
  }
}
