# 사용자 수령 시도·서명 검증·민팅 복구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자의 서명을 받아 한 번 민팅하고 중단·응답 유실을 복구한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 단계별 구현 명세와 로컬 검증 기록이다. 체크된 항목은 로컬 구현·검증을 의미하며 실제 체인 검증은 아래 미실행 게이트와 구분한다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **02·05·06·07 계약 필요; 실제 체인 검증은 CHAIN_AUTHORITY PASS**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 13절, 14절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/season-nfts/features/create-claim-attempt/create-claim-attempt.controller.ts`, `create-claim-attempt.use-case.ts`.
생성: `features/get-claim-attempt/get-claim-attempt.controller.ts`, `get-claim-attempt.use-case.ts`.
생성: `features/submit-claim-transaction/submit-claim-transaction.controller.ts`, `submit-claim-transaction.use-case.ts`.
생성: `features/reconcile-nft-transactions/reconcile-nft-transactions.use-case.ts`.
생성: `resources/solana-nft/claim-transaction-builder.ts`, `signed-transaction-validator.ts`.
위 상대 경로는 모두 `src/modules/season-nfts/` 아래다.
생성 테스트: `test/season-nft/claim-api.test.cjs`, `claim-signature.test.cjs`, `claim-recovery.test.cjs`. 테스트 상대 경로는 test/season-nft/ 기준이다.

## 작업 08.1 — 접수 API와 proof/mint 준비

**인터페이스와 인계:** 입력: 로그인 userId/참가 지갑과 READY release. 출력: 원본 14.2~14.3절의 attempt 응답 및 부분 서명 거래.

### 구현 순서

- [x] 1. 동일 claim에 20개 동시 생성 요청을 보내 하나의 attempt가 나오는 DB/HTTP 테스트를 작성한다.

- [x] 2. Origin·인증·지갑·자격·release READY를 검사한다. claim row lock 아래 CLAIMED면 기존 결과, 활성 attempt면 재사용, 없으면 QUEUED를 생성한다.

- [x] 3. worker가 MintCounter를 확인한다. 이미1이면 CLAIMED/RESOLVING으로 전환하고 발행 거래를 준비하지 않는다.

- [x] 4. 올바른 root의 proof가 없으면 ALLOWLIST_PROOF 거래를 만든다. proof finalized 후 같은 attempt의 step을 MINT로 진행한다.

- [x] 5. mint는 고정 지갑이 fee payer·minter·최초 owner가 되게 만든다. 필요한 asset key 서명만 서버가 추가한다.

- [x] 6. legacy 거래 bytes<=1232와 message hash를 저장한다. 현재 rent/protocol fee/network fee 및 priority fee 상한을 비용 추정에 포함한다.

- [x] 7. 클라이언트에는 유효한 AWAITING_SIGNATURE 거래만 반환한다. 오래된 transactionId는 새 거래로 조용히 대체하지 않는다.


### 고정할 계약·핵심 구현

```ts
export type ClaimActor = { userId: string; walletAccountId: string; walletAddress: string };
export type CreateClaimResult = {
  attemptId: string | null;
  state: 'QUEUED' | 'AWAITING_SIGNATURE' | 'SUBMITTING' | 'CONFIRMING'
    | 'SUCCEEDED' | 'EXPIRED' | 'FAILED' | 'CLAIMED';
};
// CreateClaimAttemptUseCase.execute(seasonId: string, actor: ClaimActor)
//   : Promise<{ created: boolean; result: CreateClaimResult }>
// created=true일 때만 HTTP 202, 나머지는 HTTP 200.

```

### 검증과 완료 판정

다중 탭의 attemptId 동일. proof 완료 후 mint 비용만 새로 안내. 불충분 잔액은 NFT_INSUFFICIENT_FUNDS/retryable=true이며 claim 권한 유지.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 준비·상태 조회가 HTTP 연결 안에서 finalized를 기다리지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 08.2 — 서명 거래 검증과 저장 후 접수

**인터페이스와 인계:** 입력: seasonId/attemptId, transactionId, signedTransactionBase64. 출력: 원본 14.4절 202 응답.

### 구현 순서

- [x] 1. 타인 attempt·다른 season·fee payer 변경·instruction 변경·signature 누락·oversized bytes 테스트를 작성한다.

- [x] 2. base64를 엄격히 decode하고 최대1232bytes를 검사한다. 저장한 serialized message와 byte 단위 비교한다.

- [x] 3. 00에서 확인한 SDK로 모든 필요한 서명을 검증한다. 인증 주소·고정 참가 주소·payer·최초 owner가 일치해야 한다.

- [x] 4. row lock 아래 현재 transactionId/state를 재검사한다. 유효 서명 bytes와 signature를 commit한 다음 worker 전송 대상으로 만든다.

- [x] 5. 동일 signature 재제출은 기존 상태를 반환한다. payload를 바꾼 재제출은 NFT_TRANSACTION_INVALID다.

- [x] 6. 타인의 시도는404, message mismatch는400, 만료가 확인된 거래는409로 원본 영어 오류 메시지를 반환한다.


### 고정할 계약·핵심 구현

```ts
export type SubmitClaimInput = {
  seasonId: string; attemptId: string; transactionId: string;
  signedTransactionBase64: string; actor: ClaimActor;
};
// SubmitClaimTransactionUseCase.execute(input: SubmitClaimInput)
// : Promise<SubmitClaimResult>
// 실제 네트워크 전송은 DB commit 이후 05 dispatcher만 수행한다.

```

### 검증과 완료 판정

전송 spy 실행 시점에 DB transaction state가 SIGNED인지 검사. HTTP 응답 유실 후 같은 body 재전송은 동일 signature. 다른 사용자에게 거래 bytes 노출 없음.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 서버는 임의 거래를 받아 전송하는 RPC proxy가 되지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 08.3 — 완료 검증과 재발행 차단

**인터페이스와 인계:** 입력: finalized status, 거래 meta/instructions, Core asset, MintCounter. 출력: CLAIMED/VERIFIED 또는 CLAIMED/RESOLVING; 불명확한 경우 계속 확인.

### 구현 순서

- [x] 1. 발행 성공 후 DB 오류, 사용자가 바로 자산 전송, counter1인데 이력조회 실패 테스트를 작성한다.

- [x] 2. finalized+meta.err=null만으로 끝내지 않고 예상 프로그램·collection·asset·name·URI와 최초 소유 지갑을 확인한다.

- [x] 3. 현재 소유자가 달라도 최초 mint가 고정 지갑에 이루어졌다면 완료 처리한다. 소각된 경우에도 거래 이력과 counter로 권한 소진을 유지한다.

- [x] 4. counter1/증거 미조회는 CLAIMED+RESOLVING으로 기록하고 signature 이력을 복구한다. 이 상태에서 재민팅 API를 열지 않는다.

- [x] 5. counter0/asset 없음/signature 없음/모든 조회 성공/기한 초과를 05 canExpire로 확인한 경우에만 EXPIRED 및 재시도를 허용한다.

- [x] 6. 브라우저가 직접 전송한 유효 transaction도 저장 asset 주소·counter·signature 이력으로 복구한다.


### 고정할 계약·핵심 구현

```js
// claim-recovery.test.cjs의 검증 값. 각 scenario는 테스트 fake chain의 입력이다.
const scenarios = [
  { counter: 1, receiptFound: false, expectedState: 'CLAIMED', expectedReceipt: 'RESOLVING' },
  { counter: 1, receiptFound: true, expectedState: 'CLAIMED', expectedReceipt: 'VERIFIED' }
];
// 두 경우 모두 assert.equal(createdMintTransactions, 0)를 검사한다.
// confirmed 또는 조회 실패는 EXPIRED가 아니라 기존 확인 상태를 유지한다.

```

### 검증과 완료 판정

수령 뒤 전송·소각·재로그인·중복 클릭·DB재시작의 모든 조합에서 성공 mint 최대1개. confirmed transaction은 blockheight 초과만으로 새 mint를 만들지 않는다.

실행 위치: backend.

```text
npm run test:nft && npm run test:realtime
```

기대 결과: 수령 성공과 조회 지연을 구분하면서 안전하게 복구한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: proof와 mint 각각 실제 사용자 비용을 표시한다. proof만 성공한 뒤 취소해도 그 proof 비용이 되돌아온다고 안내하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- `ClaimActor`는 `{userId:string,walletAccountId:string,walletAddress:string}`다. authenticated 세션에서만 생성하며 userId를 body에서 받지 않는다.
- CreateClaimAttemptUseCase.execute(seasonId, actor)는 `{created:boolean,result:CreateClaimResult}`를 반환한다. HTTP status는 created로 결정한다.
- GetClaimAttemptUseCase.execute(seasonId,attemptId,actor)는 원본 ClaimAttemptView를 반환한다. 타인 claim은 소유자 정보 없이404다.
- SubmitClaimTransactionUseCase.execute(input)는 `{accepted:boolean,attemptId,state,signature}`를 반환한다. accepted=true는202, 동일 bytes 재접수는200이다. accepted는 HTTP body에 넣지 않는다.
- body decode와 서명 검사 후 transaction lock에서 actor/attempt/현재 거래/state/message hash를 재확인한다. 검사와 commit 사이 상태 변경을 무시하지 않는다.
- 부분 서명 bytes를 PREPARED로 저장한다. 사용자 서명이 오면 같은 row에 완전 서명 bytes와 payer signature를 저장한다. message_hash는 서명 배열을 제외한 message의 SHA-256이다.
- fresh blockhash는 confirmed 이상으로 조회하고 lastValidBlockHeight를 함께 저장한다. 최종 완료 판정은 finalized다. 클라이언트의 height나 network를 신뢰하지 않는다.
- quote가 완성되지 않았거나 simulation이 불확실하면 AWAITING_SIGNATURE로 노출하지 않는다. quote 조회 실패와 사용자 잔액 부족을 구별한다.
- USER_PROOF가 RECONCILED이면 같은 attempt를 QUEUED/MINT로 옮긴다. USER_MINT가 RECONCILED이면 claim은 CLAIMED/RESOLVING, attempt는 SUCCEEDED다. 확인하지 못한 signature를 만들어 채우지 않는다.
- 실패 후 새 attempt는 기존 proof를 재사용한다. 부분 서명한 asset 키를 프로세스 종료로 잃어도 저장한 거래 bytes는 유지한다. 안전한 만료 후 새 attempt에서 새 asset 키를 만든다.
- UI polling은 DB만 읽는다. 서명 대기 PREPARED의 만료도 worker가 검사한다. 탭을 닫아도 이미 SIGNED인 거래는 전송·복구한다.
- 알 수 없는 chain 오류는 NFT_CHAIN_CONFIGURATION_INVALID/retryable=false로 노출하고 운영 진단을 남긴다. root/mintLimit 불일치를 일시 오류로 무한 재시도하지 않는다.

```ts
export type SubmitClaimResult = {
  accepted: boolean;
  attemptId: string;
  state: 'QUEUED' | 'AWAITING_SIGNATURE' | 'SUBMITTING' | 'CONFIRMING'
    | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  signature: string;
};
```

필수 중단 테스트 지점은 다음 네 곳이다.

1. signed bytes의 DB commit 직전과 직후.
2. send 성공 직후, HTTP 응답 전.
3. finalized 조회 직후, claim DB 갱신 전.
4. MintCounter1 확인 직후, receipt 복구 전.

재시작 결과는 기존 signature/asset으로 수렴하거나 RESOLVING으로 남아야 한다. 새 성공 mint가 발생하면 실패다.

## 최종 교차 검토 반영

- 최초 QUEUED의 step은 ALLOWLIST_PROOF로 저장한다. 아직 proof가 필요한지 확정했다는 의미는 아니다. worker가 기존 proof를 확인하면 MINT로 바꾼다. QUEUED 상태에서는 단계별 서명 안내를 표시하지 않는다.
- 동일 bytes 재제출은 요청 actor의 소유권 확인 후 **지정한 과거 transaction row**와 먼저 비교한다. 이미 접수한 동일 거래라면 현재 attempt가 MINT/QUEUED 또는 MINT/AWAITING_SIGNATURE여도200으로 현재 attempt 상태와 그 과거 signature를 반환한다. 새로운 서명을 처음 접수할 때만 현재 transactionId/state를 요구한다.
- proof submit 응답 유실 후 mint 거래가 준비된 상태에서 과거 proof body를 다시 보내는 회귀 테스트를 추가한다.200이며 proof를 다시 전송하지 않아야 한다.
- transaction을 만들기 전에 counter1을 발견해도 claims의 receipt_next_check_at을 현재 시각으로 기록한다. attempt가SUCCEEDED이고 거래 row가 없어도05의 독립 receipt scan으로 복구한다.

## 2026-10-10 로컬 구현 검증

- 판정: LOCAL_ACCEPTED. 구현 담당자와 독립 리뷰어, 주 담당자가 교차 검토했다. 미해결 중요 지적 사항은 없다.
- 집중 검증59/59, 전체 NFT184/184, 기존 realtime63/63 통과. build/typecheck/lint/format:check/git diff --check 통과.
- 실제 Nest HTTP·격리 PostgreSQL·고정 SDK를 사용해 동시 수령, 고정 지갑, 서명 변조, 과거 proof 재접수, raw8KiB, 직접 전송 효과, 확정 후 서버 중단 복구, 안전한 만료, 수수료 상한, receipt 이력 재개와 전송·소각 증거를 검증했다.
- receipt_history_before에 조회 위치를 저장한다. 알려진 서명을 먼저 검증하며 불확실한 후보를 건너뛰지 않는다. 상세 계약은 implementation-contract3.1/14를 따른다.
- 대량 이력에서는 한 작업의 최대1000개 후보 확인에 시간이 걸릴 수 있다. RPC 이력 가용성이 부족하면 CONFIRMING 또는 CLAIMED/RESOLVING을 유지하며 재발행하지 않는다.
- 커밋·push·배포·유료 거래·개발 DB 초기화는 수행하지 않았다.

남은 외부 검증:

- [ ] CHAIN_AUTHORITY: 실제 Devnet 권한 잠금·민팅·사용자 비용 검증.
- [ ] STORAGE_RECOVERY: 실제 영구 저장소 게시·복구 증거.
- [ ] 실제 지갑 UI 통합 및 Mainnet 인수:10·11 단계에서 수행.
