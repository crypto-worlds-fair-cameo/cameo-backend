import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { validateSignedClaimTransaction } from '../../../season-nfts/resources/solana-nft/signed-transaction-validator';
import { getSeasonStatus } from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';
import {
  toSeasonEntryPaymentView,
  type SeasonEntryPaymentRecord,
  type SeasonEntryPaymentView,
} from '../../resources/season-entry-payment/season-entry-payment';
import { SeasonEntryChain } from '../../resources/season-entry-payment/season-entry-chain';
import { SeasonEntryPaymentRepository } from '../../resources/season-entry-payment/season-entry-payment.repository';

// 지갑 승인 대기 기한. confirmed blockhash의 유효 시간보다 짧게 둔다.
const SIGNATURE_WINDOW_MS = 60_000;
const READ_COMMITTED = { isolationLevel: 'read committed' } as const;

type Authenticated = Readonly<{
  userId: string;
  walletAccountId: string;
  walletAddress: string;
  time: Date;
}>;

type Admission =
  | Readonly<{ kind: 'existing'; payment: SeasonEntryPaymentRecord }>
  | Readonly<{
      kind: 'new';
      auth: Authenticated;
      seasonId: string;
      recipientAddress: string;
      lamports: bigint;
    }>;

/** 유료 시즌 입장료를 개설자 지갑으로 보내는 거래를 준비·제출·확정하고 확정 시 참가를 기록한다. */
@Injectable()
export class PaySeasonEntryUseCase {
  private readonly logger = new Logger(PaySeasonEntryUseCase.name);

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly payments: SeasonEntryPaymentRepository,
    private readonly chain: SeasonEntryChain,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 열린 결제가 있으면 그대로 반환하고, 없으면 자리를 예약한 새 전송 거래를 만든다. */
  async prepare(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonEntryPaymentView> {
    this.assertOrigin(origin);
    const network = this.chain.network();
    const first = await this.transactions.run(
      (transaction) => this.admit(token, seasonId, transaction),
      READ_COMMITTED,
    );
    if (first.kind === 'existing')
      return toSeasonEntryPaymentView(first.payment);

    // RPC 왕복 동안 시즌 행 잠금을 유지하지 않도록 거래는 트랜잭션 밖에서 만든다.
    const latest = await this.withRpc(() => this.chain.latestBlockhash());
    const built = await this.chain.buildTransfer({
      payerAddress: first.auth.walletAddress,
      recipientAddress: first.recipientAddress,
      lamports: first.lamports,
      blockhash: latest.blockhash,
    });

    return this.transactions.run(async (transaction) => {
      // 잠금을 다시 얻은 뒤 참가·정원·지갑을 재확인해 그 사이 바뀐 상태로 결제를 만들지 않는다.
      const admission = await this.admit(token, seasonId, transaction);
      if (admission.kind === 'existing')
        return toSeasonEntryPaymentView(admission.payment);
      if (
        admission.auth.walletAddress !== first.auth.walletAddress ||
        admission.recipientAddress !== first.recipientAddress ||
        admission.lamports !== first.lamports
      ) {
        throw new BusinessError(ErrorCodes.SeasonStateConflict);
      }
      const payment = await this.payments.insert(
        {
          seasonId: admission.seasonId,
          userId: admission.auth.userId,
          walletAccountId: admission.auth.walletAccountId,
          payerAddress: admission.auth.walletAddress,
          recipientAddress: admission.recipientAddress,
          network,
          lamports: admission.lamports,
          preparedTransaction: built.bytes,
          messageHash: built.messageHash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          expiresAt: new Date(
            admission.auth.time.getTime() + SIGNATURE_WINDOW_MS,
          ),
          time: admission.auth.time,
        },
        transaction,
      );
      return toSeasonEntryPaymentView(payment);
    }, READ_COMMITTED);
  }

  /** 지갑이 서명한 거래가 준비 거래와 같은지 검증하고 제출 상태를 먼저 커밋한 뒤 전송한다. */
  async submit(
    origin: string | undefined,
    token: string | undefined,
    input: Readonly<{
      seasonId: string;
      paymentId: string;
      signedTransactionBase64: string;
    }>,
  ): Promise<SeasonEntryPaymentView> {
    this.assertOrigin(origin);
    this.chain.network();
    const outcome = await this.transactions.run(async (transaction) => {
      const auth = await this.authenticate(token, transaction);
      const payment = await this.payments.findOwned(
        { ...input, userId: auth.userId },
        transaction,
        true,
      );
      if (!payment)
        throw new BusinessError(ErrorCodes.SeasonEntryPaymentNotFound);
      if (payment.payerAddress !== auth.walletAddress)
        throw new BusinessError(ErrorCodes.SeasonParticipationWalletMismatch);
      // 이미 제출된 결제의 재요청은 현재 상태를 돌려주고 같은 거래를 다시 보내지 않는다.
      if (payment.status === 'SUBMITTED' || payment.status === 'CONFIRMED')
        return { kind: 'current' as const, payment };
      if (payment.status === 'EXPIRED')
        throw new BusinessError(ErrorCodes.SeasonEntryPaymentExpired);
      if (payment.status !== 'AWAITING_SIGNATURE')
        throw new BusinessError(ErrorCodes.SeasonEntryPaymentInvalidState);
      if (auth.time.getTime() >= payment.expiresAt.getTime()) {
        await this.payments.finish(payment.id, 'EXPIRED', transaction);
        return { kind: 'expired' as const };
      }
      let validated;
      try {
        validated = validateSignedClaimTransaction({
          preparedBytes: payment.preparedTransaction,
          submittedBase64: input.signedTransactionBase64,
          expectedPayer: payment.payerAddress,
          expectedMessageHash: payment.messageHash,
        });
      } catch {
        throw new BusinessError(ErrorCodes.SeasonEntryTransactionInvalid);
      }
      const submitted = await this.payments.markSubmitted(
        payment.id,
        validated.signature,
        transaction,
      );
      return {
        kind: 'send' as const,
        payment: submitted,
        bytes: validated.signedBytes,
      };
    }, READ_COMMITTED);

    if (outcome.kind === 'expired')
      throw new BusinessError(ErrorCodes.SeasonEntryPaymentExpired);
    if (outcome.kind === 'current')
      return toSeasonEntryPaymentView(outcome.payment);

    let sent;
    try {
      sent = await this.chain.send(outcome.bytes);
    } catch (error: unknown) {
      // 전송 결과를 모르면 SUBMITTED로 두고 상태 조회가 체인 증거로 확정·만료를 판단한다.
      this.logger.warn(
        `Season entry payment ${outcome.payment.id} send result is unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return toSeasonEntryPaymentView(outcome.payment);
    }
    if (sent === 'SENT') return toSeasonEntryPaymentView(outcome.payment);

    // preflight가 거절한 거래는 전파되지 않았으므로 자리 예약을 풀고 새 결제를 요구한다.
    await this.transactions.run(async (transaction) => {
      const locked = await this.payments.findOwned(
        {
          paymentId: outcome.payment.id,
          seasonId: outcome.payment.seasonId,
          userId: outcome.payment.userId,
        },
        transaction,
        true,
      );
      if (locked?.status === 'SUBMITTED')
        await this.payments.finish(
          locked.id,
          sent === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
          transaction,
        );
    }, READ_COMMITTED);
    throw new BusinessError(
      sent === 'EXPIRED'
        ? ErrorCodes.SeasonEntryPaymentExpired
        : ErrorCodes.SeasonEntryPaymentFailed,
    );
  }

  /** 제출된 거래의 체인 상태를 확인하고 확정되면 결제 지갑으로 참가를 기록한다. */
  async refresh(
    token: string | undefined,
    input: Readonly<{ seasonId: string; paymentId: string }>,
  ): Promise<SeasonEntryPaymentView> {
    const current = await this.transactions.run(async (transaction) => {
      const auth = await this.authenticate(token, transaction);
      const payment = await this.payments.findOwned(
        { ...input, userId: auth.userId },
        transaction,
      );
      if (!payment)
        throw new BusinessError(ErrorCodes.SeasonEntryPaymentNotFound);
      return payment;
    }, READ_COMMITTED);
    if (current.status !== 'SUBMITTED' || current.signature === null)
      return toSeasonEntryPaymentView(current);

    const signature = current.signature;
    const status = await this.withRpc(() =>
      this.chain.signatureStatus(signature),
    );
    let next: 'CONFIRMED' | 'FAILED' | 'EXPIRED' | null = null;
    if (status?.failed) next = 'FAILED';
    else if (status?.confirmed) next = 'CONFIRMED';
    else if (status === null) {
      // finalized height가 마지막 유효 height를 넘으면 이 거래는 더 이상 처리될 수 없다.
      const height = await this.withRpc(() =>
        this.chain.finalizedBlockHeight(),
      );
      if (height > current.lastValidBlockHeight) next = 'EXPIRED';
    }
    if (next === null) return toSeasonEntryPaymentView(current);
    const finalStatus = next;

    return this.transactions.run(async (transaction) => {
      // 참가 INSERT는 정원 판정과 같은 시즌 행 잠금 아래에서 수행한다.
      const season = await this.seasons.lockById(current.seasonId, transaction);
      if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
      const payment = await this.payments.findOwned(
        {
          paymentId: current.id,
          seasonId: current.seasonId,
          userId: current.userId,
        },
        transaction,
        true,
      );
      if (!payment)
        throw new BusinessError(ErrorCodes.SeasonEntryPaymentNotFound);
      if (payment.status !== 'SUBMITTED')
        return toSeasonEntryPaymentView(payment);
      if (finalStatus === 'CONFIRMED') {
        const participation = await this.seasons.readParticipation(
          season.id,
          payment.userId,
          transaction,
        );
        // 결제 중 시즌이 끝났어도 이미 예약한 자리이므로 확정된 입장료의 참가를 기록한다.
        if (!participation.isParticipant) {
          await this.seasons.addParticipant(
            season.id,
            payment.userId,
            payment.walletAccountId,
            payment.payerAddress,
            await this.seasons.getCurrentTime(transaction),
            transaction,
          );
        }
      }
      return toSeasonEntryPaymentView(
        await this.payments.finish(payment.id, finalStatus, transaction),
      );
    }, READ_COMMITTED);
  }

  /** 시즌 행을 잠근 뒤 참가 자격, 정원 예약과 열린 결제를 판정한다. */
  private async admit(
    token: string | undefined,
    seasonId: string,
    transaction: TransactionContext,
  ): Promise<Admission> {
    const auth = await this.authenticate(token, transaction);
    const season = await this.seasons.lockById(seasonId, transaction);
    if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
    if (season.cancelledAt !== null && season.creatorId !== auth.userId)
      throw new BusinessError(ErrorCodes.SeasonNotFound);

    const participation = await this.seasons.readParticipation(
      season.id,
      auth.userId,
      transaction,
    );
    if (participation.isParticipant || season.entryFeeLamports === '0')
      throw new BusinessError(ErrorCodes.SeasonEntryFeeNotRequired);
    const time = await this.seasons.getCurrentTime(transaction);

    const open = await this.payments.lockOpen(
      season.id,
      auth.userId,
      transaction,
    );
    if (open) {
      if (open.status === 'SUBMITTED')
        return { kind: 'existing', payment: open };
      if (
        open.expiresAt.getTime() > time.getTime() &&
        open.payerAddress === auth.walletAddress
      ) {
        return { kind: 'existing', payment: open };
      }
      // 기한이 지났거나 다른 지갑으로 다시 로그인했으면 이전 서명 요청을 닫는다.
      await this.payments.finish(open.id, 'EXPIRED', transaction);
    }

    if (getSeasonStatus(season, time) !== 'active')
      throw new BusinessError(ErrorCodes.SeasonStateConflict);
    if (season.capacity !== null) {
      const reserved = await this.payments.countReservedSeats(
        season.id,
        auth.userId,
        time,
        transaction,
      );
      if (participation.participantCount + reserved >= season.capacity)
        throw new BusinessError(ErrorCodes.SeasonCapacityReached);
    }
    const recipientAddress = await this.payments.readFeeRecipient(
      season.id,
      transaction,
    );
    if (!recipientAddress)
      throw new Error('Paid season has no entry fee recipient.');
    return {
      kind: 'new',
      auth: { ...auth, time },
      seasonId: season.id,
      recipientAddress,
      lamports: BigInt(season.entryFeeLamports),
    };
  }

  private async authenticate(
    token: string | undefined,
    transaction: TransactionContext,
  ): Promise<Authenticated> {
    const authentication = await this.authenticator.authenticate(
      token,
      transaction,
    );
    if (authentication.outcome !== 'authenticated') {
      throw new BusinessError(
        authentication.outcome === 'invalid'
          ? ErrorCodes.AuthSessionInvalid
          : ErrorCodes.AuthUserUnavailable,
      );
    }
    return {
      userId: authentication.user.id,
      walletAccountId: authentication.walletAccountId,
      walletAddress: authentication.walletAddress,
      time: authentication.time,
    };
  }

  private assertOrigin(origin: string | undefined): void {
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
  }

  /** RPC 장애는 내부 오류 대신 입장료 일시 중단 오류로 공개한다. */
  private async withRpc<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof BusinessError) throw error;
      this.logger.warn(
        `Season entry RPC failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BusinessError(ErrorCodes.SeasonEntryFeeUnavailable);
    }
  }
}
