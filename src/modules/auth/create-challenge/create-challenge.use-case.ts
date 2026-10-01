import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '../../../business-error';
import type { AllConfigType } from '../../../config/config.type';
import { TransactionRunner } from '../../../database/transaction/transaction-runner';
import { AUTH_CHALLENGE_TTL_SECONDS } from '../challenge/challenge';
import { ChallengeRepository } from '../challenge/challenge.repository';
import { createSiwsSignInInput, type SiwsSignInInput } from '../siws/siws';

export type CreateChallengeResult = Readonly<{
  challengeId: string;
  signInInput: SiwsSignInInput;
  browserBinding: string;
}>;

function isValidBrowserBinding(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

@Injectable()
export class CreateChallengeUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly challenges: ChallengeRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 허용된 프론트 출처에 대한 SIWS 입력을 생성하고 DB 저장을 확정한다.
   * 브라우저 연결값 원문은 HTTP 계층이 쿠키로만 전달하며, DB에는 해시만 저장한다.
   */
  async execute(
    origin: string | undefined,
    browserBinding?: string,
  ): Promise<CreateChallengeResult> {
    // CORS 응답 헤더와 별개로 출처를 검증해, 비허용 요청이 DB를 변경하지 못하게 한다.
    const allowedOrigins = this.config.getOrThrow('cors.originList', {
      infer: true,
    });
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new BusinessError({
        kind: 'forbidden',
        code: 'AUTH_ORIGIN_NOT_ALLOWED',
        message: '허용되지 않은 요청 출처입니다.',
      });
    }

    // 이 값은 이후 서명 요청이 챌린지를 발급받은 브라우저에서 왔는지 확인할 때 쓴다.
    // 기존 값을 유지하면 앞서 발급한 미사용 챌린지도 같은 브라우저에서 사용할 수 있다.
    const binding = isValidBrowserBinding(browserBinding)
      ? browserBinding
      : randomBytes(32).toString('base64url');
    const browserBindingHash = createHash('sha256')
      .update(binding)
      .digest('hex');
    const challengeId = randomUUID();
    const nonce = randomBytes(32).toString('hex');

    // DB 시각으로 발급·만료를 구성하고, 커밋까지 완료된 결과만 컨트롤러에 전달한다.
    return this.transactions.run(async (transaction) => {
      const createdAt = await this.challenges.getIssueTime(transaction);
      const expiresAt = new Date(
        createdAt.getTime() + AUTH_CHALLENGE_TTL_SECONDS * 1000,
      );
      const signInInput = createSiwsSignInInput({
        origin,
        challengeId,
        nonce,
        createdAt,
        expiresAt,
      });

      // 인증 방식은 서버 정책으로 선택하고, 응답에 반환할 입력을 그대로 저장한다.
      await this.challenges.create(
        {
          id: challengeId,
          authMethod: 'siws',
          nonce,
          verificationPayload: signInInput,
          browserBindingHash,
          createdAt,
          expiresAt,
        },
        transaction,
      );
      return { challengeId, signInInput, browserBinding: binding };
    });
  }
}
