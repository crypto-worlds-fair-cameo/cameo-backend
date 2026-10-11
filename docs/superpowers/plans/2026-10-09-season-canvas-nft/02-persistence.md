# NFT 상태 모델과 DB 불변 조건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 발행 준비·수령·거래·업로드 상태를 DB 제약과 함께 영속화한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 작업 명세와 구현 검증 기록이다. 체크박스는 실제 구현·검증 후에만 체크한다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **01 완료**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 11절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `db/migrations/2026-10-09-02-season-nft.sql`, `src/modules/season-nfts/season-nfts.module.ts`.
생성: `src/modules/season-nfts/resources/season-nft/season-nft.ts`, `season-nft.repository.ts`.
생성: `src/modules/season-nfts/resources/claim/claim.repository.ts`, `src/modules/season-nfts/resources/solana-nft/nft-transaction.repository.ts`, `src/modules/season-nfts/resources/nft-media/nft-upload.repository.ts`.
생성 테스트: `test/season-nft/schema.test.cjs`, `test/season-nft/repositories.test.cjs`.
변경: `src/app.module.ts`의 imports에 SeasonNftsModule 등록. 기존 TransactionRunner를 재사용한다.

## 작업 02.1 — 테이블·제약·상태 타입

**인터페이스와 인계:** 입력: 원본 11절. 출력: releases/claims/attempts/transactions/uploads 다섯 테이블 및 코드 상태 union.

### 구현 순서

- [x] 1. 현재 migration fixture 방식으로 빈 DB에 모든 migration을 적용하는 테스트를 만든다. raw INSERT로 필수 제약을 우회할 수 없는지 검사한다.

- [x] 2. 원본 11절 컬럼을 작성하고 모든 상태·network는 NOT NULL+CHECK로 제한한다. timestamps와 next_attempt_at의 기본값은 CURRENT_TIMESTAMP로 고정한다.

- [x] 3. READY 필수값과 EMPTY eligible_count=0 조건을 CHECK로 추가한다. claims는 release/network 및 user/wallet 복합 FK를 갖게 한다.

- [x] 4. 활성 attempt 및 진행 중·완료 operation partial UNIQUE를 아래처럼 생성한다. FAILED/EXPIRED만 새 transaction 생성이 가능하며 FINALIZED/RECONCILED operation을 다시 실행하지 않는다.

- [x] 5. uploads.state를 PREPARED/UPLOADED/VERIFIED/FAILED로 제한한다. 재시도는 같은 row/data item을 유지한다.

- [x] 6. transactions에 `estimated_cost_lamports bigint NULL CHECK (estimated_cost_lamports >= 0)`, `estimated_at timestamptz NULL`을 추가한다. 사용자 서명 대기 거래에는 둘 다 필수이며 서버가 조회 API에서 저장값을 반환한다.

- [x] 7. 준비 keypair 식별자는 releases의 `preparation_keys jsonb NOT NULL DEFAULT '{}'`에 주소별 상대 파일 식별자로 저장한다. 절대 경로나 비밀키 bytes를 공개 응답에 포함하지 않는다.


### 고정할 계약·핵심 구현

transaction의 release/network가 일치하고 attempt가 같은 release의 claim에 속하는지 repository에서 검증한다. 클라이언트가 transactionId만 바꿔 타인의 거래를 선택할 수 없어야 한다.

```sql
CREATE UNIQUE INDEX season_nft_one_active_attempt
ON season_nft_claim_attempts (claim_id)
WHERE state IN ('QUEUED','AWAITING_SIGNATURE','SUBMITTING','CONFIRMING');
CREATE UNIQUE INDEX season_nft_one_live_or_completed_operation
ON season_nft_transactions (network, release_id, operation_key)
WHERE state IN ('PREPARED','SIGNED','SUBMITTED','CONFIRMED','FINALIZED','RECONCILED');
```

### 검증과 완료 판정

동일 release/network, 동일 claim/user, 동일 claim/wallet, 동시 활성 시도, network 다른 claim, READY 필수값 누락을 각각 DB에서 거절한다. FINALIZED가 있는 operation을 새로 시작하려는 repository 호출도 거절한다.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: SQL 제약과 repository 조건이 함께 중복을 차단한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 02.2 — 잠금·조건부 갱신·기능 비활성 모듈

**인터페이스와 인계:** 입력: TransactionRunner/PgTx. 출력: 원자적 claim 생성과 상태 CAS, disabled 상태에서 외부 네트워크 없이 부팅하는 module.

### 구현 순서

- [x] 1. 서로 다른 DB connection 두 개가 동일 claim에 attempt를 생성하는 경쟁 테스트를 작성한다.

- [x] 2. claim row FOR UPDATE 아래 CLAIMED·기존 활성 attempt를 먼저 조회한다. 없을 때만 INSERT한다. unique race는 재조회로 처리한다.

- [x] 3. 상태 전이는 WHERE state=expected 조건과 반환 row 개수로 성공을 판단한다. CLAIMED를 되돌리는 repository 메서드를 만들지 않는다.

- [x] 4. operation_key를 setup:<stage>:<substep>, claim:<attemptId>:<step> 형식으로 고정한다. blockhash 만료 재작성도 같은 operation_key를 유지한다.

- [x] 5. 네트워크·외부 SDK 호출은 DB 트랜잭션 안에 넣지 않는다. Module 등록 시 disabled면 worker와 SDK 네트워크 요청을 시작하지 않는다.


### 고정할 계약·핵심 구현

```sql
UPDATE season_nft_claims
SET state = 'CLAIMED', receipt_state = 'RESOLVING', updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND state IN ('UNCLAIMED', 'PROCESSING')
RETURNING id;
-- 후속 증거 복구는 CLAIMED를 유지한 채 receipt_state만 VERIFIED로 바꾼다.

```

### 검증과 완료 판정

두 동시 create 호출은 같은 활성 attemptId를 반환한다. CLAIMED 후 재요청으로 새 attempt가 생기지 않는다. disabled 부팅에서는 RPC spy 호출 수 0.

실행 위치: backend.

```text
npm run test:nft && npm run typecheck
```

기대 결과: 프로세스 메모리를 비워도 DB에서 상태를 재구성할 수 있다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 스키마와 repository 경쟁 테스트 통과. 아직 정상 종료 워커나 실제 발행은 연결하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

[구현 결정 계약 3절](implementation-contract.md)의 컬럼·인덱스·FK가 최종 schema 계약이다. 아래 책임 경계를 적용한다.

| 소유 파일 | 제공할 행위 | 원자성 |
| --- | --- | --- |
| season-nft.repository.ts | candidate insert, freeze, 단계 CAS, BLOCKED/retry | release row lock, version 검사 |
| claim.repository.ts | findOwnClaim, getOrCreateAttempt, completeClaim, failAttempt | claim→attempt row lock |
| nft-transaction.repository.ts | insertPrepared, acceptSigned, recordEvidence, replaceExpired | release/claim→attempt→transaction lock |
| nft-upload.repository.ts | prepareItem, recordReceipt, markVerified | release/kind UNIQUE, 같은 item ID 유지 |

메서드 이름은 위로 고정한다. 인자는 의미 있는 object로 넘기고 transaction context가 필요한 함수는 마지막 인자 `transaction: TransactionContext`로 받는다. 요청마다 repository instance를 만들지 않는다. 공개 UseCase 계약은 해당 작업 문서대로 유지한다.

- getOrCreateAttempt 반환은 `{created:boolean,claimState,attemptId:string|null,attemptState:string|null}`다. 이미CLAIMED면 created=false와 attemptId=null이다.
- acceptSigned 입력은 transactionId, expectedMessageHash, signedBytes, signature다. 결과는 `{accepted:boolean,currentTransactionState,signature}`다. 같은 bytes면 accepted=false의 idempotent 결과다.
- 단계 CAS의 `expectedVersion` 불일치는 오류가 아닌 lost-race 결과 `{updated:false}`다. stale worker가 frozen/READY 값을 덮어쓰지 않는다.
- CHECK의 NULL 논리를 주의한다. `CHECK(state<>'READY' OR field IS NOT NULL)`처럼 필수 여부를 명시한다. `CHECK(count>0)`만으로 NULL을 금지했다고 생각하지 않는다.
- state='RECONCILED'는 reconciliation_evidence가 NOT NULL이어야 한다. 증거가 없는 계정을 만들었다고 표시하는 API는 제공하지 않는다.
- 신규 migration은 BEGIN/COMMIT, RLS, 소유 의미 COMMENT를 기존 형식으로 작성한다. applied migration을 수정하지 않는다.

필수 concurrent 테스트는 별도 PoolClient2개로 같은 claim을 잠그고 create를 경쟁시킨다. Promise.all만 사용하면서 실제 connection이 한 개라면 경쟁 검증으로 인정하지 않는다. operation FINALIZED와 새PREPARED를 동시에 시도하는 경우도 포함한다.


- 최종 추가: claims.receipt_next_check_at(timestamptz NULL), receipt_retry_count(integer NOT NULL DEFAULT0 CHECK>=0)와 RESOLVING due partial index를 만든다. 완료 attempt가 없어도 receipt 작업을 검색할 수 있어야 한다. 정확한 선택 조건은 구현 결정 계약14절이다.

## 구현 검증 기록 — 2026-10-10

상태: **LOCAL_VERIFIED**. 02.1·02.2의 로컬 구현과 root·독립 리뷰어 교차 검토를 완료했다.

- 5개 RLS 테이블, FK·UNIQUE·상태 제약, receipt 재조회 인덱스와 저장소를 구현했다. READY/EMPTY 참여자 수 NULL을 명시적으로 거절한다.
- 두 실제 DB 연결에서 활성 수령 시도와 완료 거래의 중복 생성을 검증했다. CLAIMED와 FINALIZED를 되돌리는 경로를 차단했다. 시도 행 없이도 receipt를 RESOLVING에서 VERIFIED로 복구한다.
- stale CAS는 입력 검증보다 먼저 패배를 반환한다. 실패 업로드는 같은 ID·해시·경로일 때만 같은 행으로 재시도한다.
- 최종 스냅샷 저장을 시즌 우선 잠금으로 맞췄다. 실제 저장·freeze 경쟁 테스트와 기존 강제 종료 스냅샷 동작을 검증했다.
- 스키마 6개, 저장소 16개, 전체 NFT 65개, 기존 캔버스 63개 테스트 통과. build, typecheck, lint, format, diff 검사 통과.
- 개발 DB 초기화·migration, 실제 RPC·업로드·배포는 실행하지 않았다. 테스트는 격리 DB를 사용했다.
- 후속 의무: 03 명단 재조회, 04 실제 업로드 복구, 05 DB-only SQLSTATE40001/40P01 최대3회 재시도, 08 사용자 소유권 인증, 배포 환경 DB role 접근 검증은 각 단계에서 수행한다.
