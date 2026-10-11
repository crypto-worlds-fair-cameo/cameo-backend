# PostgreSQL 워커와 RPC 처리량·거래 복구 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 한 leader가 RPC 한도와 저장된 거래의 전송·확정·만료를 관리한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 작업 명세와 로컬 구현 검증 기록이다. 체크된 항목은 로컬 검증 완료를 뜻하며 실제 체인·배포 검증 완료를 뜻하지 않는다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **02 완료**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 15절, 17절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/season-nfts/resources/nft-worker/nft-worker.ts`, `rpc-scheduler.ts`, `nft-worker-config.ts`.
생성: `src/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher.ts`.
변경: `season-nfts.module.ts`, `.env.example`.
생성 테스트: `test/season-nft/worker.test.cjs`, `test/season-nft/transaction-dispatcher.test.cjs`.
설정 연결은 기존 ConfigModule 패턴을 사용한다. 기존 DB pool을 재사용하되 leader용 connection을 따로 점유한다.

## 작업 05.1 — leader와 공유 RPC scheduler

**인터페이스와 인계:** 입력: network와 원본 17절 설정. 출력: Nest lifecycle worker 및 모든 NFT RPC를 통과시키는 scheduler.

### 구현 순서

- [x] 1. fake clock·RPC spy로 읽기5RPS, send1200ms, 사용자10건마다 준비1건 처리 테스트를 작성한다.

- [x] 2. 전용 DB connection에서 pg_try_advisory_lock으로 network별 leader를 확보한다. 아래 고정 namespace와 network 숫자를 사용한다.

- [x] 3. lock connection error/end가 발생하면 신규 job 시작을 즉시 멈춘다. 이미 전송된 거래는 결과를 미확정으로 저장하고 새 leader가 같은 bytes로 복구한다.

- [x] 4. scheduler의 queue는 메모리 순서만 관리한다. 실제 작업과 next_attempt_at은 DB에 남기고 재기동 시 재조회한다.

- [x] 5. 원본의 우선순위·backoff·Retry-After를 구현한다. 종료 시 polling timer를 해제하고 connection을 반환한다.

- [x] 6. 기능 disabled는 외부 연결 없이 부팅한다. enabled 설정 누락·비밀 파일 권한·디렉터리 static root 포함은 시작 오류다.
- [x] 6a. 실제 RPC getGenesisHash와 선택 network 불일치를 시작 오류로 처리한다. 06에서 production provider와 시작 순서를 연결하고 mismatch 로컬 테스트를 통과했다. 실제 배포 endpoint 검증은 10에서 별도로 수행하며 아직 미완료다.


### 고정할 계약·핵심 구현

```sql
-- 첫 인자는 NFT worker namespace, 두 번째는 devnet=1/mainnet-beta=2.
SELECT pg_try_advisory_lock(20261009, $1) AS acquired;
-- 반드시 획득한 동일 connection에서 해제한다.
SELECT pg_advisory_unlock(20261009, $1);

```

### 검증과 완료 판정

DB connection 두 개 중 leader1개. leader 종료 후 같은 호스트에서 동일 지속 볼륨을 사용하는 테스트 runner가 takeover. connection loss 후 신규 RPC0건. send 호출 간격>=1200ms, read rolling 1초<=5회.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 무료 RPC 한도를 모든 HTTP/worker 프로세스가 개별 소비하지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 05.2 — 저장된 거래의 전송·확정·만료 판정

**인터페이스와 인계:** 입력: SIGNED transaction row. 출력: SUBMITTED/CONFIRMED/FINALIZED/FAILED/EXPIRED와 다음 검사 시각.

### 구현 순서

- [x] 1. 전송 성공 뒤 응답 유실, confirmed 뒤 timeout, finalized height 초과의 세 시나리오를 fake chain으로 작성한다.

- [x] 2. DB에 서명 bytes와 signature가 있는 거래만 scheduler를 통해 전송한다. RPC 반환 signature와 저장 signature가 다르면 오류로 차단한다.

- [x] 3. 네트워크 오류·429는 같은 signed bytes를 재전송한다. blockhash 또는 asset 주소를 바꾸지 않는다.

- [x] 4. confirmation 조회는 batch 처리하고 finalized 성공과 meta.err를 분리한다. 업무별 자산·counter 검증은 06/08에서 추가한다.

- [x] 5. 아래 만료 판단 조건을 전부 만족할 때만 EXPIRED로 전환한다. confirmed면 deadline 경과만으로 만료시키지 않는다.

- [x] 6. 로그에서 signed bytes·cookie·RPC URL key를 제외하고 작업 ID·stage·duration·retryCount만 남긴다.


### 고정할 계약·핵심 구현

```ts
export type ExpiryEvidence = {
  finalizedHeight: bigint;
  lastValidBlockHeight: bigint;
  signature: 'ABSENT' | 'CONFIRMED' | 'FINALIZED' | 'FAILED';
  accountEvidence: 'ABSENT' | 'SUCCESS' | 'UNKNOWN';
  allQueriesSucceeded: boolean;
};
export function canExpire(e: ExpiryEvidence): boolean {
  return e.allQueriesSucceeded && e.finalizedHeight > e.lastValidBlockHeight
    && e.signature === 'ABSENT' && e.accountEvidence === 'ABSENT';
}
```

### 검증과 완료 판정

UNKNOWN·query failure·CONFIRMED 입력은 모두 false. 성공 응답 유실 후 동일 signature로 finalized 수렴. 키·signed bytes가 capture된 로그에 없어야 한다.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 전송 응답과 실제 체인 성공을 구분하고 부정확한 새 거래 생성을 막는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: worker failover는 외부 작업의 exactly-once를 보장한다고 주장하지 않는다. 고정 tx·계정·업로드 ID와 DB 제약으로 중복 효과를 방지한다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- 설정 factory 신규 경로는 `src/config/season-nft.config.ts`다. app.module.ts의 ConfigModule load와 SeasonNftsModule import를 변경한다.
- 원본17절 key를 그대로 사용하며 bool은 true/false만 허용한다. NFT_RPC_READ_RPS는 정수1..5, NFT_RPC_SEND_INTERVAL_MS는 정수>=1200, priority fee cap은 음수 없는 십진 정수다. 유료 전환 시 상한 변경은 별도 설정 검증 수정으로 명시한다.
- scheduler 입력은 `{kind:'USER_SEND'|'USER_CHECK'|'USER_BUILD'|'RELEASE_PREPARE', run:()=>Promise<T>}`다. DB에 callback을 저장하지 않고 kind와 대상ID를 조회해 run을 구성한다.
- 후보는 due time ASC, created_at ASC, id ASC로 선택한다. pending attempt와 release에는 각각 next_attempt_at을 사용한다. GET 요청이 RPC job을 무제한 생성하지 않는다.
- preparation의 one job은 영속 checkpoint1개까지다. 모든 시즌의 전체 준비를 한 번에 끝내야 양보하는 긴 작업을 만들지 않는다.
- 체인 send lane 동시성1개와 공유 RPC limiter는 SDK 내부 자동send/retry도 포함한다. storage lane은 별도1개이며 chain 작업을 막지 않는다. SDK `.sendAndConfirm()`이 limiter를 우회하지 않도록 builder와 전송을 분리한다.
- 복구된 목표 효과는 transaction RECONCILED이며 operation을 다시 전송하지 않는다. 정확한 signature 확인이 뒤늦게 가능하면 그 증거를 별도로 갱신한다.
- signed bytes를 저장하기 전에 전송하는 코드 경로가 없는지 provider와 script를 점검한다. production provider는 하나의 dispatcher를 사용한다.
- 잘못된 config는 enabled startup을 실패시키지만 disabled는키·RPC가 없어도 부팅한다. preflight는 enabled 여부와 관계없이 명시적으로 실행할 수 있다.

고정 시계 테스트에서 0ms,100ms,200ms,300ms,400ms에 read5회를 시작했다면 999ms에6번째를 시작하지 않는다. send가 중간에 있었다면 그만큼 read 슬롯을 줄인다. 1200ms 미만 간격의send2회는 금지다. leader loss 테스트는 이미 시작한 호출을 취소했다고 주장하지 말고 **그 이후 새 호출 수0**을 검사한다.


- 최종 운영 범위는 backend replica1개와 지속 볼륨이다. DB advisory lock은 중복 runner 방지와 동일 환경 재시작 복구에 사용하며 다중 호스트 failover를 구현하지 않는다.
- storage lane에서120초 동안 지연되는 업로드를 시작해도 chain lane에서 사용자 send/check가 RPC limiter 범위 내에 진행되는 fake-clock 테스트를 추가한다.
- CLAIMED/RESOLVING claim을 pending attempt/transaction과 독립적으로USER_CHECK 큐에 넣는다. receipt_next_check_at/receipt_retry_count로 재시작 후 재개하고VERIFIED에서 종료한다.

## 구현 검증 기록 — 2026-10-10

- 로컬 구현과 root·독립 리뷰어의 교차 검토를 통과했다. 검토 지적10개를 모두 수정했다.
- `npm run test:nft`:144/144, `npm run test:realtime`:63/63 통과. typecheck, lint, format:check, git diff --check 통과.
- storage 작업20개와 user 작업100개의 동기적 예약으로 대기열을 제한한다. 서로 다른 lane은 독립적으로 진행한다.
- transaction의 confirmation_check_count와 retry_count, attempt의 retry_count를 DB에 저장한다. 전송 우선순위와 rpcType READ/SEND는 별개다.
- 거래 조회는 NftCheckDecision.resendSigned를 반환한다. 실패·누락·불완전 조회는 같은 tick의 전송을 허용하지 않으며, 완전한 부정 증거만 exact bytes 재전송을 허용한다.
- 저장 I/O는 NftStorageIo의 signal/assertMayStart로 각 원격 호출 직전 권한을 검사한다. 종료는 active scheduler 작업까지 하나의15초 예산에 포함한다.
- 06/08 구체 provider는 아직 연결하지 않았다. 현재 unavailable provider는 명시적으로 실패하며 READY·확정을 꾸며내지 않는다.
- CHAIN_AUTHORITY와 STORAGE_RECOVERY는NOT_RUN이다. 실제 네트워크 정체성 검증, 체인·저장소 실행 및 지속 볼륨 배포 증거는 후속 단계에서 완료해야 한다.
