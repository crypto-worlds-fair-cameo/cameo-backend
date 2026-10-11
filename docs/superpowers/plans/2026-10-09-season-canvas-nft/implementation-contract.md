# 시즌 NFT 구현 결정 계약 — revision 2

이 문서는 구현자가 사용자에게 다시 물을 필요가 없도록 작업 간 공통 결정과 실패 시 행동을 고정한다. 제품 요구사항은 [원본](../../specs/2026-10-09-season-canvas-nft-design.md) REQ-001~024를 유지한다. 원본의 기술 개요보다 이 문서의 구체적 상태·검증·응답 규칙을 우선한다. 같은 계약을 변경하면 원본·해당 작업·테스트를 함께 갱신한다.

## 1. 질문 없이 진행하는 범위

- 기본 실행은00부터11까지 순서대로다. 구현 자체에 추가 승인 질문을 만들지 않는다. 이 문서 작성은 구현 실행 요청이 아니다.
- 내부 함수 분리·같은 책임 파일의 이동·SDK import 방식·호환 patch 버전 선택은 구현자가 코드와 검증으로 결정한다. 정책 질문으로 넘기지 않는다.
- 모르는 SDK API를 추정해서 구현하지 않는다. 00의 자동 조사·검증 규칙을 적용한다. 외부 접근 불가면 LOCAL_VERIFIED / EXTERNAL_VALIDATION_PENDING으로 구분하고 독립 작업을 계속한다.
- 키·RPC 계정·잔액은 동료가 운영 runbook으로 제공하는 외부 입력이다. 더미 키를 저장하거나 사용자를 대신해 결제하지 않는다. 미입력 시 구체적인 설정 key와 실행할 명령을 인계한다.
- Core/Candy Guard로 불변성·1회·지갑 제한을 충족하지 못하면 evidence에 BLOCKED_TECHNICAL을 기록한다. 커스텀 프로그램, compressed NFT 또는 운영자 변경 가능 모델로 몰래 바꾸지 않는다. 이는 미정 정책이 아니라 기술 검증 실패다.

## 2. 실제 저장소 계약

- Root module: `src/app.module.ts`; 기존 ConfigModule.load 배열에 nft 설정 factory, imports에 SeasonNftsModule을 추가한다.
- backend lifecycle: `src/modules/seasons/resources/season/season-state.ts`의 SeasonStatus. 값은 `scheduled | active | ended | cancelled`다. force-ended 여부는 ended 값만으로 판단하지 않고 seasons.force_ended_at을 조회한다.
- frontend lifecycle: `src/pages/season-canvas/api/seasons.types.ts`의 같은 값 집합을 재사용한다. 별도 대문자 enum을 만들지 않는다.
- 스냅샷의 through_sequence와 비교할 head는 **canvases.last_chunk_sequence**다. legacy last_sequence를 사용하지 않는다.
- SessionAuthenticationResult는 invalid/unavailable/authenticated 판별 union이다. authenticated 분기에만 walletAccountId, walletAddress, chainNamespace를 추가한다. 기존 token/sessionId/time/user 구조와 호출 규칙을 보존한다.
- `TransactionRunner.run<T>(fn: (transaction: TransactionContext) => Promise<T>, options?: {isolationLevel: 'read committed'}): Promise<T>`를 사용한다. TransactionContext를 PoolClient로 캐스팅하는 새 관례를 만들지 않는다.
- 쓰기 요청은 기존 assertAuthOrigin, 인증 실패는 AUTH_SESSION_INVALID 401 / `Authentication is required.`를 재사용한다. unavailable 사용자는 AUTH_USER_UNAVAILABLE 403 / `This account cannot sign in.`이다.
- 기존 IP limiter는 `src/http/rate-limit/rate-limiter.ts`, 기본60초100회이며 메모리 기반이다. NFT에 Redis나 별도 사용자 rate-limit 저장소를 추가하지 않는다. 초과 시429 / ThrottlerException / `ThrottlerException: Too Many Requests`를 사용하고 원본 NFT_RATE_LIMITED 신규 코드는 도입하지 않는다. 05의 RPC limiter는 이 HTTP limiter와 별개다.

## 3. DB 구현 결정

원본11절의 5개 테이블을 만든다. 모든 식별자 생성은 서버 randomUUID 또는 SQL gen_random_uuid 중 기존 repository 패턴을 사용하되 응답 타입은 UUID다. FK 삭제는 모두 RESTRICT다. state/network/kind/retry_count와 생성·갱신 시각은 NOT NULL이다. updated_at은 repository의 변경 SQL에서 CURRENT_TIMESTAMP로 갱신한다.

### 3.1 추가·명확화 컬럼

| 테이블 | 컬럼 | 정확한 계약 |
| --- | --- | --- |
| releases | preparation_keys | jsonb NOT NULL DEFAULT '{}'::jsonb; Collection/Machine/Guard 공개주소를 key, 루트 기준 key 파일명을 value로 저장 |
| releases | image_byte_length | bigint NULL CHECK >0; PNG 재조회 크기 검증 |
| releases | version | bigint NOT NULL DEFAULT0 CHECK >=0; CAS 성공 시+1 |
| claims | receipt_next_check_at | timestamptz NULL; RESOLVING 진입 시 CURRENT_TIMESTAMP, VERIFIED 시NULL |
| claims | receipt_retry_count | integer NOT NULL DEFAULT0 CHECK >=0; receipt 재조회 backoff에 사용 |
| claims | receipt_history_before | text NULL; finalized receipt 이력 조회의 다음 before signature. 재시작 후 이어서 조회하며 VERIFIED 시NULL |
| claim_attempts | retry_count | integer NOT NULL DEFAULT0 CHECK >=0; build 실패 backoff를 재시작 후에도 유지 |
| transactions | confirmation_check_count | integer NOT NULL DEFAULT0 CHECK >=0; 정상 미확정 조회의5/10/15/15초 단계를 유지 |
| transactions | retry_count | integer NOT NULL DEFAULT0 CHECK >=0; 일시 RPC 오류 backoff를 유지하고 정상 조회/전송 시 초기화 |
| transactions | estimated_cost_lamports | bigint NULL CHECK >=0; USER_PROOF/USER_MINT의 PREPARED에서는 필수 |
| transactions | estimated_at | timestamptz NULL; 위 비용과 함께 필수 |
| transactions | cost_breakdown | jsonb NULL; 아래 quote 구성요소의 십진 문자열 |
| transactions | reconciliation_evidence | jsonb NULL; RECONCILED에서는 필수. 검증한 계정 주소·slot·operation·확인 시각만 저장 |
| uploads | state | PREPARED / UPLOADED / VERIFIED / FAILED |
| uploads | verified_at | timestamptz NULL; VERIFIED에서는 필수 |

transactions.kind는 SETUP_COLLECTION, SETUP_MACHINE, SETUP_GUARD, SETUP_LOCK, USER_PROOF, USER_MINT 중 하나다. 한 setup 단계가 여러 거래이면 operation_key의 substep으로 나눈다. kind는 첫 작업의 의미를 따른다. byte_length는 양수, hashes는 소문자64자리hex, merkle_root는32bytes, proof 각 node는32개 0..255 정수다.

### 3.2 FK·중복·확정값 보호

- `canvas_snapshots(canvas_id,id)` UNIQUE를 추가하고 releases `(season_id,snapshot_id)`에서 복합 FK로 참조한다. 다른 canvas의 snapshot 연결을 DB가 거절한다.
- releases `(id,network)` UNIQUE 및 claims `(release_id,network)` 복합 FK, claims `(user_id,wallet_account_id)` 복합 FK를 둔다.
- attempts는 `(id,claim_id)` UNIQUE를 둔다. transaction의 release/network와 attempt의 claim.release_id 일치는 transaction 생성 repository가 같은 DB 트랜잭션에서 조회해 검사한다.
- claim `(release_id,user_id)`, `(release_id,wallet_address)`, `(network,asset_address)` UNIQUE를 둔다. NULL asset은 PostgreSQL 기본 NULL distinct 규칙을 사용한다.
- 활성 attempt는 QUEUED/AWAITING_SIGNATURE/SUBMITTING/CONFIRMING에 한 개다.
- operation의 **진행 중 또는 성공 거래 전체를 묶어 UNIQUE**로 제한한다. 별도 active/finalized 인덱스 두 개로 나누지 않는다.

```sql
CREATE UNIQUE INDEX season_nft_one_live_or_completed_operation
ON season_nft_transactions(network, release_id, operation_key)
WHERE state IN ('PREPARED','SIGNED','SUBMITTED','CONFIRMED','FINALIZED','RECONCILED');
```

- operation_key: setup:<stage>:<substep> (substep은 00 실행 순서의 0부터 시작하는 정수), claim:<attemptId>:<ALLOWLIST_PROOF|MINT>. 만료 재작성은 같은 operation_key다.
- 같은 operation 거래 교체는 release 또는 claim lock 아래 기존 거래가 FAILED/EXPIRED인 경우만 허용한다. unique 충돌은 기존 행 재조회로 처리한다.
- FROZEN 이후 snapshotId/throughSequence/count/title/description/endedAt/root/claim 집합은 repository에서 쓰기 금지다. URI/hash/준비주소는 NULL→확정값 1회만 허용하고 기존 값과 같으면 no-op, 다르면 BLOCKED다.
- READY 이후 확정 필드는 불변이며 next check/운영 오류·updated_at만 변경 가능하다. claim의 CLAIMED는 다른 상태로 되돌릴 수 없다.
- READY는 snapshot/count>0/root/name/hash/URI/세 주소/locked_at/ready_at 모두 NOT NULL. EMPTY는 count=0, 온체인 세 주소와 URI가 NULL이다.
- CLAIMED/RESOLVING은 asset/signature/claimed_at NULL 허용. VERIFIED는 asset/signature/claimed_at 모두 필수다. claimed_at은 최초 민팅의 finalized 확인 시각이고 단순 counter 발견 시각이 아니다.
- JSON proof 구조와 frozen 불변성은 repository와 입력 validator가 검사한다. PostgreSQL JSON용 복잡한 트리거 엔진은 도입하지 않는다.
- 신규 테이블은 기존 migration처럼 RLS를 활성화한다. 실제 backend DB role에서 접근 가능한지 통합 테스트한다. 브라우저 직접 DB 접근 policy를 추가하지 않는다.

## 4. 원자적 처리 순서와 상태 전이

락 순서는 필요한 범위에서 **season → release → claim → attempt → transaction**이다. 모든 repository가 같은 순서를 지킨다. 외부 RPC·파일 읽기·업로드 중에는 DB 트랜잭션을 유지하지 않는다. SQLSTATE40001/40P01은 외부 효과 없는 DB 구간만 최대3회 재시도한다.

### 4.1 release

| 현재 | 사건 | 다음 | 영속 효과 |
| --- | --- | --- | --- |
| 없음 | 정상 종료 후보 | WAITING_SNAPSHOT/SNAPSHOT | season/network UNIQUE insert |
| WAITING_SNAPSHOT | final 없음 | 동일 | next_attempt_at +60초 |
| WAITING_SNAPSHOT | final 검증·기여0 | EMPTY/FROZEN | snapshot·count0 고정, 외부비용0 |
| WAITING_SNAPSHOT | final 검증·기여1..100 | PREPARING/FROZEN | frozen 값·claims·root atomic commit |
| PREPARING | image 검증 | PREPARING/IMAGE | URI/hash 고정 |
| PREPARING | metadata 검증 | PREPARING/METADATA | URI/hash 고정 |
| PREPARING | collection finalized | PREPARING/COLLECTION | 주소·거래증거 |
| PREPARING | machine/guard finalized | PREPARING/MACHINE | 주소·설정 검증 |
| PREPARING | 잠금 finalized·재조회 일치 | READY/LOCKED | locked_at/ready_at 기록 |
| WAITING_SNAPSHOT 또는 PREPARING | 데이터/설정 불일치 | BLOCKED/기존stage | 마지막 오류와 frozen 값 보존 |
| BLOCKED | retry CLI 재검사 성공 | WAITING_SNAPSHOT 또는 PREPARING | snapshot 미확정이면 전자, 아니면 후자 |

후보 감지 후 정상 종료 조건이 깨졌으면 BLOCKED의 NFT_SOURCE_INELIGIBLE로 기록하고 공개 availability는 UNAVAILABLE다. 취소·강제 종료를 자동 복구해 READY로 만들지 않는다.

### 4.2 claim·attempt

| 사건 | claim | attempt |
| --- | --- | --- |
| 최초 접수 | PROCESSING | QUEUED/ALLOWLIST_PROOF; worker가 기존 proof 발견 시MINT로 전환 |
| 거래 준비 commit | PROCESSING | AWAITING_SIGNATURE |
| signed bytes commit | PROCESSING | SUBMITTING |
| RPC 접수 또는 timeout 후 확인 시작 | PROCESSING | CONFIRMING |
| proof 목표 계정 finalized 확인 | PROCESSING | QUEUED/MINT; 이어서 새 blockhash 거래 준비 |
| mint finalized 검증 | CLAIMED/VERIFIED | SUCCEEDED |
| MintCounter1, receipt 미확인 | CLAIMED/RESOLVING | SUCCEEDED; UI는 정보 확인 중 |
| 확정 실패 또는 안전한 만료 | UNCLAIMED | FAILED 또는 EXPIRED; 다음 click은 새 attempt |
| 사용자가 서명 팝업 취소 | 변화 없음 | AWAITING_SIGNATURE 유지 |

- MINT를 준비하려면 proof의 owner/program/root/guard/machine/wallet이 모두 기대값이고 finalized여야 한다.
- proof와 mint 모두 실패한 transaction 교체를 자동 서명하지 않는다. FAILED/EXPIRED는 새 받기 클릭으로 재접수한다. 이미 존재하는 proof는 다음 attempt에서 재사용한다.
- 지갑 미연결·서명 취소는 프론트 로컬 상태다. 취소 API나 claim 취소 상태를 추가하지 않는다.
- 서명 대기 중 blockhash 만료도 worker가 검사한다. 브라우저가 직접 전송했을 수 있어 제출 API를 안 불렀다는 사실만으로 실패·만료로 판단하지 않는다.

### 4.3 transaction과 외부 효과 복구

PREPARED→SIGNED→SUBMITTED→CONFIRMED→FINALIZED가 정상 경로다. 조회가 이미 finalized면 중간 단계는 건너뛸 수 있다. SIGNED 상태에서 timeout이면 signed bytes를 유지하고 확인·재전송한다. meta.err가 확정되면 FAILED다.

**RECONCILED**를 내부 terminal 상태로 추가한다. 올바른 proof, setup 계정 또는 MintCounter1 등 목표 효과가 finalized로 확인되지만 해당 거래 signature 성공을 아직 증명할 수 없는 경우다. 이 상태를 FINALIZED라고 위장하지 않으며 재전송하지 않는다. 이후 정확한 거래 증거를 찾으면 FINALIZED/FAILED를 기록할 수 있으나 이미 달성한 업무 상태를 되돌리지 않는다. 실패한 원래 거래와 외부에서 성공한 거래가 다르면 원래 거래는 FAILED, claim은 CLAIMED를 유지한다.

- proof가 외부에서 등록된 경우 이전 PREPARED proof 거래는 RECONCILED로 종료하고 MINT를 준비한다.
- counter1이면 진행 중 mint 거래를 RECONCILED로 종료하고 receipt를 복구한다. new asset을 만들지 않는다.
- 만료는 finalized height > lastValidBlockHeight AND 이 signature 부재 AND 해당 mint asset 부재 AND MintCounter0 AND 모든 조회 성공일 때만 인정한다. proof/setup은 목표 효과가 존재하면 EXPIRED 대신 RECONCILED다.
- `canExpire`의 accountEvidence는 해당 operation의 효과에 대한 판정이다. UNKNOWN은 항상 false다. confirmed status가 있으면 만료로 바꾸지 않는다.
- unconfirmed status나 계정 조회는 finalized/confirmed level을 기록하고 혼용하지 않는다. 최종 상태 변경에는 finalized 증거를 사용한다.

## 5. snapshot·기여자 확정 규칙

- PNG 파일은 reader에서 lock 없이 읽고 hash·byte length를 검증한다. freeze 트랜잭션에서 snapshot ID/status/is_final/last_chunk_sequence와 후보 종료 조건을 다시 읽는다.
- 자격의 출발점은 `SELECT DISTINCT user_id FROM canvas_stroke_usages WHERE canvas_id=$1`이다. participants와 **LEFT JOIN**하여 누락을 검출한다. INNER JOIN으로 누락 사용자를 제거하지 않는다.
- usage 있음/participant 없음, 지갑 계정 user 불일치, 주소 불일치, 잘못된 Solana public key, 중복 지갑이면 NFT_ELIGIBILITY_CORRUPT로 BLOCKED다. 101명 이상이면 기존 시즌 제약 위반으로 BLOCKED다. 초과 인원을 잘라내지 않는다.
- Merkle 명단은 Base58 주소의 ASCII byte 순서로 정렬한다. localeCompare를 쓰지 않는다. root/proof 생성·검증은00에서 검증한 SDK API로 한다.
- 최종 head에 포함되는 usage인가를 신규 chunk 완료 flag로 필터링하지 않는다. 기존 append 승인·drain·final snapshot 경계가 확정된 이후의 usage 집합을 사용한다.
- 동일 root/proof 계산을 두 번 실행해 같은 결과인지 검사하고 한 번 저장한 root/proof를 재생성하지 않는다.

## 6. 워커와 재시도 숫자

- PostgreSQL leader namespace20261009, network devnet1/mainnet2. v1 지원 배포는 backend replica1개와 재시작 후 같은 경로로 복원되는 지속 볼륨이다. dedicated connection1개로 중복 runner를 방지하되 다른 호스트의 자동 failover를 보장하지 않는다. 여러 replica 운영은 공유 저장소 검증을 포함한 후속 범위다.
- 체인 send lane 동시성1개와 storage upload/gateway lane 동시성1개를 분리한다. 업로드120초 대기 중에도 사용자 send/check가 진행되어야 한다. API는 DB 접수만 수행한다. 원격 RPC는 read 최대5회/초, send 사이 최소1200ms, 합산 read+send 최대5회/초로 관리한다.
- limiter는 monotonic clock의 rolling window와 nextSendAt을 사용한다. 버스트 burst5가 경계를 넘어10회가 되는 fixed window 방식은 쓰지 않는다.
- job scan1초, 시즌 후보 scan60초. pending signature는 최대100개로 batch. 확인 간격5초,10초,15초, 이후15초다.
- 사용자 send→확인→build→시즌 준비 우선순위. 연속 사용자 작업10개를 실행했고 준비 작업이 due이면 다음1개는 준비다.
- 네트워크/RPC timeout10초, 업로드 전송120초, gateway 조회30초. timeout은 실패 확정이 아니라 재조회 대상이다.
- retry base=[5,15,60,300,900]초, 이후900초. jitter는 base의0..20%를 더한다. Retry-After가 더 길면 그 시각을 지킨다. 일시 오류는 횟수만으로 영구 실패로 바꾸지 않는다.
- insufficient service balance/storage credits는 비용 지출 없이5분 뒤 재검사한다. 사용자 잔액 부족은 attempt FAILED/NFT_INSUFFICIENT_FUNDS/retryable=true다.
- account owner/config/hash 불일치, 서명키 파일 유실, frozen 값 충돌은 BLOCKED이며 자동 유료 재시도를 하지 않는다.
- leader connection loss 즉시 신규 I/O 시작 금지. 이미 시작된 네트워크 호출 취소가 성공했다고 가정하지 않는다. 결과는 저장한 operation ID와 CAS로 조정한다.
- shutdown은 신규 job을 멈추고 최대15초 대기 후 종료한다. DB commit이 끝난 signed bytes와 upload item 파일은 유지한다.
- 로그 이벤트는 `season_nft.release_blocked`, `season_nft.rpc_retry`, `season_nft.transaction_finalized`, `season_nft.claim_resolving`. IDs/network/state/retryCount/duration만 넣고 비밀값은 제외한다. 별도 모니터링 SaaS 도입은 필수가 아니다.

## 7. HTTP 응답과 상태 우선순위

모든 GET도 기존 세션 인증이 필요하다. body parser와 Nest validation의 기존 순서는 유지한다. UseCase 내부에서는 Origin→인증→소유권→기능 상태→업무 자격 순으로 검사한다. 단, 없는/타인 attempt의 존재 여부는404로 통일한다. UUID와 base64 외에 클라이언트가 network/owner/가격/metadata를 지정하지 못한다.

### 7.1 SeasonNftView

availability 판정 순서: CANCELLED→FORCE_ENDED→FEATURE_DISABLED→WAITING_FOR_END→EMPTY→READY→PREPARING. 정상 종료의 release가 아직 없으면 PREPARING이다. BLOCKED도 PREPARING이며 내부 오류는 노출하지 않는다. name/imageUrl/metadataUri는 검증·확정된 값만 반환한다. freeze 전 eligibleCount는 null이다.

claim eligibility는 NOT_PARTICIPANT→NO_VALID_STROKE→ELIGIBLE 순으로 판정한다. freeze 전에도 참가 지갑은 반환한다. 참가하지 않은 사용자만 walletAddress=null이다. claim row가 아직 없으면 state=UNCLAIMED/receiptState=NONE/나머지null로 반환한다. 기능 disabled여도 이미 기록된 CLAIMED와 링크는 숨기지 않는다.

조회 network 설정: `SOLANA_NETWORK`가 명시된 `devnet` 또는 `mainnet-beta`일 때 해당 network의 DB 자료만 조회한다. 기능 disabled 자체는 조회를 막지 않으며 기존 CLAIMED와 링크를 그대로 반환한다. disabled 부팅에서 network 미설정을 허용하는 기존 설정 정책은 유지하되, network가 없는 상태의 두 NFT 조회 API는 인증 확인 후 기존 `NFT_SERVICE_UNAVAILABLE`(503, 필수 설정 장애)를 반환한다. devnet을 임의 기본값으로 선택하거나 DB의 임의 release에서 network를 추론하지 않는다. 이는 기능 비활성화에 따른 503과 구별한다. 배포 시 NFT 조회를 사용하려면 기능 활성 여부와 관계없이 network를 설정한다.

### 7.2 create/get/submit

| 상황 | HTTP | 응답 또는 code |
| --- | --- | --- |
| create 신규 | 202 | `{attemptId,state:'QUEUED'}` |
| create 활성 재요청 | 200 | 현재 attemptId/state |
| create 이미 수령 | 200 | `{attemptId:null,state:'CLAIMED'}` |
| get 타인/다른 시즌/없는 attempt | 404 | NFT_CLAIM_ATTEMPT_NOT_FOUND |
| submit 최초 서명 commit | 202 | `{attemptId,state:'SUBMITTING',signature}` |
| submit 동일 서명 재전송 | 200 | 현재 attempt state와 같은 signature |
| submit 오래된 terminal 거래 | 409 | NFT_TRANSACTION_EXPIRED 또는 NFT_TRANSACTION_INVALID_STATE |
| submit 메시지·서명·payer 불일치 | 400 | NFT_TRANSACTION_INVALID |

- create에서 이미 CLAIMED면 신규 기능 일시중지보다 기존 결과를 우선 반환한다. 활성 attempt 재요청도 기존 시도를 반환한다. disabled는 새 작업 생성을503으로 막는다.
- get.transaction은 state=AWAITING_SIGNATURE이고 대응 PREPARED row가 유효할 때만 값이 있다. expired 검사 대기에는 null, state는 QUEUED 또는 CONFIRMING이며 서명 버튼을 열지 않는다.
- 소유권 검사 후 요청 transactionId의 저장 bytes와 먼저 비교한다. 이미 접수된 같은 bytes면 현재 step/currentTransactionId 여부와 관계없이200으로 현재 attempt 상태와 과거 signature를 반환한다. 최초 서명 접수에서만 current transaction/state를 재검사한다.
- get.retryable은 FAILED/EXPIRED이며 오류가 재접수 허용 목록에 있을 때 true, 나머지는 false다. 사용자 서명 취소의 다시 서명 버튼은 로컬 상태로 처리한다.
- POST signedTransactionBase64는 최대1644문자, canonical padded base64이며 decode 후1..1232bytes다. 요청 JSON body는8KiB 이내다. 비표준 base64의 관대한 Node decode 결과를 그대로 허용하지 않는다.
- fee payer가 만드는 transaction signature는64bytes Base58로 저장한다. 서버 keypair signature를 거래 ID로 잘못 쓰지 않는다.
- 불필요한 fee payer 서명 외 message 수정·blockhash 교체·instruction 추가·부분서명 삭제는 거절한다.

### 7.3 공개 오류 추가 및 기존 오류

원본14.6절 오류에 아래를 추가한다. message는 그대로 사용한다.

| HTTP/위치 | code | message | 재시도 |
| --- | --- | --- | --- |
| 403 참가 API | SEASON_PARTICIPATION_WALLET_MISMATCH | Use the wallet that originally joined this season. | 원래 지갑 로그인 |
| 409 submit | NFT_TRANSACTION_INVALID_STATE | This transaction is no longer awaiting a signature. | 상태 갱신 |
| attempt | NFT_INSUFFICIENT_FUNDS | Insufficient SOL to complete this transaction. | true |
| attempt | NFT_TRANSACTION_FAILED | The transaction failed. Please try again. | true |
| attempt | NFT_TRANSACTION_EXPIRED | The transaction has expired. Please try again. | true |
| attempt | NFT_CHAIN_CONFIGURATION_INVALID | NFT claims are temporarily unavailable. | false |

HTTP rate limit은 기존 RateLimiter 오류 그대로다. chain429는 내부 재시도이며 사용자 NFT_RATE_LIMITED로 바꾸지 않는다. 알 수 없는 오류를 retryable=true로 분류하지 않는다. FREE RPC 장애 때문에 claim 자격을 제거하지 않는다.

### 7.4 참여 목록

limit20/최대50, offset0. joined_at DESC,season_id DESC. total은 같은 요청의 DB read committed 한 트랜잭션에서 계산하되 새 참가로 인한 페이지 이동은 offset 방식의 허용 특성이다. N+1 RPC 금지, usage count는 사용자/시즌별 집계한 뒤 JOIN한다. finalImageUrl은 검증된 final snapshot URL, 없으면 null이다. 제목/기간/lifecycle은 현재 시즌 데이터, NFT name/URI는 frozen 데이터다.

## 8. 수수료와 저장 URI

- quote 구성은 transactionFeeLamports + priorityFeeLamports + accountRentLamports + protocolFeeLamports다. 모두 bigint≥0, 총합만 estimatedCostLamports로 API 반환하고 상세는 DB cost_breakdown에 저장한다.
- 기본 priority fee0. 설정 상한이 양수이면 추정값과 상한 중 작은 값을 사용한다. transactionFeeLamports가 이미 priority를 포함하면 분리해 중복 합산하지 않는다.
- SDK/version별 account 생성 rent·프로토콜 비용은00에서 실제 balance delta와 대조한다. 알 수 없는 항목을0으로 넣지 않는다. simulation/quote가 실패하면 QUEUED 상태로 재시도하고 서명 거래를 노출하지 않는다.
- quote는 작성 당시 추정치이며60초 이상 지난 미서명 거래는 새 blockhash로 자동 교체하지 않는다. 먼저 만료·외부 전송 여부를 확인한다. UI에 estimatedAt과 변동 가능성을 표시한다.
- 거래 실패 시 체인에서 이미 소비된 network fee가 남을 수 있다. rent/protocol fee 환불을 임의 약속하지 않는다.
- 영구 image와 metadata URI는 `https://arweave.net/<dataItemId>`를 사용한다. 조회 가용성 확인용 gateway 설정을 바꿔도 이미 고정한 onchain URI를 바꾸지 않는다. devnet도 이 기능 검증의 최종 URI는 영구 게시를 사용한다. sandbox는00 단독 업로드 호환성 실험에만 허용한다.
- metadata JSON은 UTF-8 BOM 없음, JSON.stringify의 공백 없음, 마지막 newline 없음. attributes 순서는 공유 테스트와 같고 Contributors는 JSON number다.
- upload 파일은 `<workDir>/<releaseId>/<kind-lowercase>.signed`로 atomic write, mode0600, directory0700. rename 전에 fsync, DB commit 후 전송. 공개 다운로드는 해당 파일을 제공하지 않는다.
- 공개 URI는 요청한 data item ID에 대응해야 하며 응답 bytes 길이/sha256이 일치해야 VERIFIED다. HTTP200만으로 성공 처리하지 않는다. gateway 지연은 같은 ID로 재조회한다.

## 9. 프론트 결정

- 카드는 항상 기존 디자인 토큰과 번역을 따른다. 별도 페이지/모달을 새로 만들지 않는다. 상태 메시지는 aria-live=polite, 버튼은 busy 중 disabled다.
- 기본 CTA: READY/UNCLAIMED는 `NFT 받기`, proof는 `참여 자격 등록 서명`, mint는 `NFT 발행 서명`, 취소는 `다시 서명`, FAILED/EXPIRED retryable은 `다시 시도`다.
- 첫 받기는 준비만 한다. 비용과 단계가 표시된 뒤 사용자 click으로 지갑을 연다. proof 이후 mint 팝업도 자동으로 열지 않는다.
- 선택 지갑이 다르면 `이 시즌에 참여한 지갑으로 연결해 주세요.`를 표시한다. 임의 재로그인·지갑 연결 팝업을 자동 실행하지 않는다.
- query key는 userId/seasonId/attemptId와 서버 network를 포함한다. network를 아직 모르면 status query는 userId/seasonId만 사용하고 응답 network 변경 시 해당 사용자 NFT cache를 제거한다.
- profile 목록은 페이지20개, 더보기 버튼으로 다음 offset을 요청한다. item의 동일 seasonId는 병합 시 중복 제거한다. 전체 user profile 페이지를 샘플 교체 대상으로 확대하지 않는다.
- 참여 목록 query 자체는 visible30초 polling, hidden pause, 복귀 refetch를 수행한다. 각 카드는 추가 idle status polling을 만들지 않는다. 목록 응답의 nft를 사용하고 해당 카드에서 수령을 시작했을 때만 상세 status/attempt query를 활성화한다.
- 서명 bytes는 React 메모리에만 둔다. localStorage/sessionStorage·analytics로 보내지 않는다. userId/account/network 변경 시 요청 결과를 폐기한다.
- asset 링크: `https://explorer.solana.com/address/<asset>`; 거래 링크: `https://explorer.solana.com/tx/<signature>`. devnet만 `?cluster=devnet`을 붙인다. 문자열은 Base58 검증 후 encodeURIComponent로 조립한다.
- 지원 Wallet Standard chain은 devnet→solana:devnet, mainnet-beta→solana:mainnet이다. 사용자 지갑이 signTransaction을 지원하지 않으면 `이 지갑은 거래 서명을 지원하지 않습니다.`로 막는다. 새 지갑 SDK 강제 도입은 하지 않는다.

## 10. 운영 입력과 중단 조건

- startup validation은 network/endpoint URL/keyfile/path 형식·권한·snapshot enabled를 검사한다. filesystem이 영구 볼륨인지는 코드가 확정할 수 없다. 동료가 실제 재배포 후 파일 보존을 확인해 인수 기록에 남긴다.
- preflight는 read-only이며 지속성에 PASS를 추측하지 않는다. 수동 재배포 증거가 없으면 PENDING 항목으로 출력한다.
- DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL, DB_SSL_CA 및 기존 DB pool/timeout 설정을 재사용한다. 신규 DATABASE_URL 계약을 만들지 않는다. reset은 runbook의 서비스 중지 후만 수행한다.
- 스크립트 exit code: 0=모든 실행 검사 통과, 1=검증 실패, 2=설정/인자 누락, 3=외부 검증 미실행·수동 확인 대기. stdout은 `{status,checks:[{id,status,code,message}]}` JSON, 진단은 마스킹한 stderr다.
- preflight와 Devnet scripts에 `--help`, `--json`을 제공한다. 운영 preflight/retry는 빌드를 실행하지 않고 배포 때 생성한 dist를 읽는다. dist 부재는exit2다. 기계 판독에는 `npm run --silent nft:preflight -- --json`처럼 npm 배너도 제거한다. Devnet 검증은 `--execute` 없으면 외부 mutation을 실행하지 않고 검사 목록만 출력한다.
- reset은 `--apply --expected-season-count N --manifest <absolute-path>`를 모두 요구한다. 기본은 dry-run. 이미 NFT release가 있거나 expected count가 다르면 exit1이다. 파일 정리 재실행은 `--cleanup-manifest <absolute-path>`이며 DB DELETE를 다시 하지 않는다.
- retry-release는 `--release-id UUID --network devnet|mainnet-beta`; DB row network와 불일치하면 exit1. BLOCKED만 처리하고 READY/EMPTY는 읽기 결과만 반환한다.
- 환경의 chain 정체성은 URL 문자열이 아닌 RPC getGenesisHash와 선택 network의 공식 genesis hash로 확인한다. 00에서 공식값을 fixture에 고정하며 endpoint 교체 시 재검사한다.
- 기본 RPC 제공자 Helius, 특정 API key나 paid plan은 코드에 포함하지 않는다. 한도 변경은 원본17절 설정으로 반영한다.
- Mainnet 인수 담당은 동료다. 실제 지갑 서명·비용 부담 없는 자동 테스트만으로11을 PASS 처리하지 않는다.

## 11. 작업별 필수 실패 증거

각 작업 문서의 테스트와 함께 아래 사례를 반드시 포함한다. 테스트가 순수 함수만 검사하고 외부 경계 실패를 생략하면 완료가 아니다.

| 작업 | 입력/사건 | 기대 결과 |
| --- | --- | --- |
| 00 | protocol 권한 검증 미실행 | EXTERNAL_VALIDATION_PENDING; 외부 검증 PASS 금지 |
| 01 | 사용자A 세션에 사용자B wallet FK | DB23503 |
| 02 | FINALIZED/RECONCILED operation에 신규 PREPARED | DB23505 |
| 03 | usage 존재·participant 없음 | BLOCKED; 조용히 대상에서 제외 금지 |
| 04 | 성공 응답 유실 후 restart | 동일 item ID, 새 게시 항목 생성0 |
| 05 | leader 연결 소실 직후 due job | 새 I/O 시작0 |
| 06 | lock 성공 후 DB commit 실패 | 같은 계정 재조회 후 READY; 새 컬렉션0 |
| 07 | 타인 claim row가 있는 동일 시즌 | 본인 claim만 반환 |
| 08 | counter1·signature 이력 unavailable | CLAIMED/RESOLVING, 신규 mint0 |
| 09 | wallet popup 열린 상태에서 logout | 반환된 서명 submit0 |
| 10 | 영구 볼륨 확인 증거 없음 | 지속성 PENDING; false PASS 금지 |
| 11 | Devnet signature만 제출 | Mainnet 인수 FAIL |

## 12. 외부 근거와 검증 한계

ImmutableMetadata의 동작은 [Metaplex 공식 문서](https://www.metaplex.com/docs/smart-contracts/core/plugins/immutableMetadata)를 참고한다. 현재 발행 경로에서 개별 Asset에 이 플러그인이 자동 생성된다고 가정하지 않는다. 실제 Asset의 Collection update authority 연결과 잠긴 Collection의 권한으로 불변성을 검증한다. MintLimit과 AllowList는 각각 [MintLimit 문서](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/mint-limit), [AllowList 문서](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/allow-list)를 따른다. 이 문서 작성 시점에는 실제 권한 이관 후 mint·업로드 복구를 실행하지 않았다. 구현자는00에서 같은 설치 SDK와 실제 프로그램으로 그 동작을 검증한다.

### 12.1. 오류·설정 소유 파일

- 신규 `src/modules/season-nfts/resources/season-nft/season-nft.error-codes.ts`에서 NFT 업무 오류를 정의하고 `src/errors/error-codes.ts`에 합친다. statusCode/code/message/description 형식은 기존 SeasonErrorCodes와 같다.
- 참가 지갑 mismatch는 기존 `src/modules/seasons/resources/season/season.error-codes.ts`에 추가한다. NFT module이 seasons 오류를 소유하지 않는다.
- `src/config/season-nft.config.ts`의 이름은 seasonNft이며 `src/config/config.type.ts`의 AllConfigType에 seasonNft 필드를 추가한다. `app.module.ts`의 ConfigModule load에 등록한다.
- 실제 SDK package 버전·program/genesis 값과 외부 계정별 endpoint는00이 기계적으로 검증해 기록하는 산출물이다. 임의 상수로 문서를 채우거나 이미 검증한 것처럼 서술하지 않는다.

## 13. 2026-10-10 최신 기준 호환성

[09의 최신 main 기준 보완](09-frontend-claim.md)을 적용한다. backend ca0554b는 변경 없고 frontend bd58aca의 신규 메인 히스토리는 NFT 범위에 포함하지 않는다. NFT 영구 이미지는 canonical Arweave URL의 일반 img 표시로 처리하며 기존 canvas snapshot 복구 loader의 origin 제한을 변경하지 않는다. profile summary와 전체 SeasonNftView는 다른 타입이며 카드 props는09의 SeasonNftClaimCardProps로 고정한다. 번역은 common namespace의 seasonNft key 그룹을 사용한다.

## 14. 최종 교차 검토로 확정한 복구·운영 범위

### receipt 재조회

- worker는 매 tick에 claims의 `state='CLAIMED' AND receipt_state='RESOLVING' AND receipt_next_check_at<=CURRENT_TIMESTAMP`를 독립 조회한다. 작업 종류는USER_CHECK다. pending attempt/transaction 존재를 요구하지 않는다.
- `(receipt_next_check_at,id)` partial index predicate는 `state='CLAIMED' AND receipt_state='RESOLVING'`만 사용한다. CURRENT_TIMESTAMP는 index predicate가 아닌 조회 WHERE에만 쓴다. 확인 성공은VERIFIED로 변경하고 receipt_next_check_at=NULL, 실패는 receipt_retry_count를 증가시키고6절 backoff를 적용한다. 이 경로는 read-only chain 조회만 하며 mint를 만들지 않는다.
- SUCCEEDED attempt와 거래row0개 상태에서 서버를 재시작한 뒤에도 receipt 복구를 재개하는 테스트를 포함한다.
- 이미 저장된 mint signature는 이력 조회보다 먼저 검증한다. 이력 조회는 한 작업당 제한된 페이지를 읽고 다음 before signature를 receipt 재시도 일정과 함께 영속 저장한다. 매 재시도마다 최신 이력으로 되돌아가 오래된 mint를 누락하지 않는다. RPC 실패 시 처리하지 못한 후보를 건너뛰도록 cursor를 진행하지 않는다. 조회 끝까지 도달했지만 증거가 없으면 RESOLVING을 유지하며 이후 재조회할 수 있어야 한다.
- 최근 조회 한도를 초과하는 이력과 서버 재시작을 포함한 복구 테스트, 저장된 signature 검증이 이력 조회 장애에 의존하지 않는 테스트를 포함한다.

### 파일 복구와 배포 범위

- v1은 backend replica1개다. snapshot/upload/key 디렉터리는 재배포 후 동일한 볼륨을 연결해야 한다. 호스트 자동 failover와 공유 filesystem 구축은 구현 범위가 아니다.
- key/signed-item 최초 발행은 임시 파일에 쓰고 fsync한 뒤 기존 최종 파일을 덮어쓰지 않는 atomic publish로 수행한다. POSIX에서는 같은 filesystem의 임시 파일을 최종 경로에 link하고 EEXIST이면 기존 파일을 읽어 검증한 뒤 임시 파일을 삭제할 수 있다. 일반 rename으로 기존 key를 교체하지 않는다.
- 파일 존재·DB 기록 없음이면 기존 파일의 ID/pubkey/hash를 검증해 채택한다. 다른 새 key/item으로 덮어쓰지 않는다. DB의 주소/ID와 파일이 다르면BLOCKED다. cleanup 대상은 DB에서 참조하지 않는 임시 파일로 한정한다.

### 외부 검증 게이트의 분리

00 증거의 gates는 LOCAL_SDK, CHAIN_AUTHORITY, STORAGE_RECOVERY이며 각각 PASS/FAIL/NOT_RUN이다. overallStatus는 전체 결과의 요약일 뿐 다른 책임의 구현을 일괄 차단하는 플래그가 아니다.

- LOCAL_SDK: 실제 export·버전·직렬화·Merkle/크기 검증. 순수 계산과 fake provider 작성의 근거다.
- CHAIN_AUTHORITY: Devnet 권한 잠금 후 민팅·외부/중복 차단·전송/소각 후 재수령 차단·수수료 검증.06/08의 실제 chain integration 검증에 필요하다.
- STORAGE_RECOVERY: 같은 signed item 재사용·영구 게시·공개 hash 검증.04의 실제 게시 검증에 필요하다.
- 01~03 DB/reader,04 순수 JSON/fake uploader,05 scheduler/fake chain,07 API fixtures,08 API/signature tests,09 fixture UI,10 runbook은 해당 외부 gate가 미실행이어도 구현한다. 미실행 gate를PASS로 기록하지 않는다.
- 실제 READY는 검증된 영구 metadata와 chain 설정을 모두 요구하며 통합 Devnet/Mainnet 완료 조건은 완화하지 않는다. 기술 실패만 해당 provider 진행을 막고, 외부 키·계정 미입력은 해당 실행의PENDING이다.

### preflight 수동 증거 입력

`nft:preflight -- --evidence <absolute-path> --json`은 아래 파일을 읽는다. 파일이 없으면 PERSISTENCE_EVIDENCE=PENDING/exit3이며 다른 자동 검사 결과는 출력한다. network/commit/configuredPaths 불일치 또는 hash 불일치는FAIL이다. stdout은 CLI가 쓴 JSON 한 개이며 SDK 진단은stderr로 보낸다.

```ts
type PersistenceEvidence = {
  schemaVersion: 1;
  network: 'devnet' | 'mainnet-beta';
  backendCommit: string;
  checkedAt: string; // UTC ISO8601
  restartVerified: true;
  paths: Array<{
    purpose: 'snapshot' | 'upload' | 'preparation-key';
    absolutePath: string; // 설정된 지속 디렉터리의 절대경로
    probeRelativePath: string; // 이 루트 내부의 비민감 시험 파일
    sha256Before: string; // 재배포 전 테스트 파일의64자리 hash
    sha256After: string; // 재배포 후 같은 파일의 hash
  }>;
};
```

paths에는 세 purpose가 각각1회 있어야 한다. absolutePath는 현재 해당 설정 루트와 realpath가 같아야 한다. probeRelativePath의 절대경로·경로 이탈·symlink 이탈을 거절하고 현재 파일의SHA256도 sha256Before/sha256After와 같은지 직접 검증한다. 증거는 운영자의 재배포 시험 기록이며 디렉터리 존재만으로 생성하지 않는다. 비밀키 자체가 아닌 비민감 테스트 파일로 검증한다. 빌드는 배포 준비에서 한 번 실행하고 운영 CLI마다 dist를 삭제·재생성하지 않는다.

Collection은 임시 ImmutableMetadata 제거와 update authority의 lock PDA 이전을 단일 거래로 처리한다. 최종 Collection의 메타데이터는 서명 불가능한 관리 권한으로 잠그며, 발행에 필요한 정확한 Machine PDA delegate만 유지한다. 상세 실행·readback 조건은 06의 Collection 메타데이터 잠금 절을 따른다.
