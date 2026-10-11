# 인증 지갑 및 시즌 참가 지갑 고정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 로그인에서 검증한 지갑을 세션과 시즌 참가 기록에 고정한다.

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

- 선행 작업: **없음. 00과 독립 개발 가능**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 10절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

변경: `src/modules/auth/resources/session/session.repository.ts`, `session-authenticator.ts`, `src/modules/auth/features/login/login.use-case.ts`, `src/modules/auth/features/me/me.use-case.ts`.
변경: `src/modules/seasons/resources/season/season.repository.ts`, `features/create-season/create-season.use-case.ts`, `features/join-season/join-season.use-case.ts`.
생성: `db/migrations/2026-10-09-01-season-participation-wallets.sql`, `scripts/season-nft/reset-development-seasons.cjs`, `test/season-nft/wallet-binding.test.cjs`.
프론트 변경: `src/entities/session/api/session.api.ts`, `src/app/layout/header/model/useWalletAuthentication.ts`, `src/pages/profile/ui/ProfileContent.tsx`.
기존 테스트 기반: `test/canvas/database-fixture.cjs`. 프론트 경로는 frontend 저장소 기준이다.

## 작업 01.1 — 개발 초기화와 지갑 FK

**인터페이스와 인계:** 입력: 기존 auth/season 스키마. 출력: 세션과 참가 행의 NOT NULL wallet FK. reset 명령은 사용자가 실제 실행할 때만 데이터를 삭제한다.

### 구현 순서

- [x] 1. 기존 사용자를 가진 DB에서 신규 migration이 지갑을 임의 추정하지 않는지 실패 테스트를 만든다. main canvas·users·wallets 보존 fixture도 준비한다.

- [x] 2. 초기화 스크립트의 기본 동작을 dry-run으로 만든다. 실제 실행은 `--apply --expected-season-count N` 두 인자를 모두 요구하고 예상 개수가 다르면 중단한다.

- [x] 3. 새 NFT 테이블 존재 시 release 수를 조회하여 1개라도 있으면 거절한다. 애플리케이션 중지 상태를 운영 절차의 선행 조건으로 명시한다.

- [x] 4. 시즌 ID와 image/continuation 키 manifest를 먼저 영속화한다. 원본 10.2절 삭제 순서대로 season 데이터 및 구세션을 하나의 DB 트랜잭션에서 제거한다.

- [x] 5. commit 후 manifest의 파일만 루트 내부 경로 검증 뒤 제거한다. 파일 삭제 실패는 DB rollback으로 표시하지 않고 manifest 기준 재시도를 허용한다.

- [x] 6. migration에 UNIQUE(user_id,id), 세션·참가 복합 FK, season/wallet UNIQUE와 NOT NULL을 적용한다. 기존 row가 있으면 설명 가능한 오류로 중단한다.


### 고정할 계약·핵심 구현

```sql
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_user_id_id_key
  UNIQUE (user_id, id);
ALTER TABLE auth_sessions ADD COLUMN wallet_account_id uuid NOT NULL;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_user_wallet_fk
  FOREIGN KEY (user_id, wallet_account_id) REFERENCES user_wallets(user_id, id);
ALTER TABLE season_participants
  ADD COLUMN wallet_account_id uuid NOT NULL,
  ADD COLUMN wallet_address text COLLATE "C" NOT NULL;
ALTER TABLE season_participants ADD CONSTRAINT season_participant_wallet_fk
  FOREIGN KEY (user_id, wallet_account_id) REFERENCES user_wallets(user_id, id);
ALTER TABLE season_participants ADD CONSTRAINT season_wallet_unique
  UNIQUE (season_id, wallet_address);
```

### 검증과 완료 판정

다른 사용자 지갑 참조는 SQLSTATE 23503, 동일 시즌 동일 주소는 23505. dry-run 전후 데이터 동일, apply 후 main/users/wallets 동일, 새 NFT release 존재 시 reset 거절.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: migration은 빈 개발 시즌 상태에서 통과하고 불명확한 기존 지갑 backfill을 하지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 01.2 — 로그인·참가에 실제 서명 지갑 전달

**인터페이스와 인계:** 입력: SIWS 검증으로 얻은 WalletAccount.walletId. 출력: `SessionAuthenticationResult`의 walletAccountId/walletAddress/chainNamespace 및 `/auth/me.activeWallet`.

### 구현 순서

- [x] 1. 로그인한 지갑이 wallets 배열의 첫 항목이 아닌 fixture를 만들고 activeWallet이 실제 로그인 지갑인지 검사한다.

- [x] 2. sessions.create에 walletAccountId를 추가하고 세션 조회를 user_wallets와 JOIN한다. 유효 지갑이 없는 세션은 인증 실패로 처리한다.

- [x] 3. create-season 자동 참가와 join-season 일반 참가 모두 인증 문맥의 지갑을 전달한다. 재참가의 지갑 비교는 기존 idempotent return보다 먼저 수행한다.

- [x] 4. 고정 참가 주소와 다르면 SEASON_PARTICIPATION_WALLET_MISMATCH를 반환한다. 같은 주소면 기존 참가를 유지한다.

- [x] 5. /auth/me 응답 모델·Swagger·frontend session 타입과 헤더를 동시에 갱신한다. 전체 로그인 UI를 재작성하지 않는다.


### 고정할 계약·핵심 구현

```ts
type ActiveWallet = { id: string; chainNamespace: 'solana'; address: string };
// 기존 인증 결과의 userId 등 필드는 유지한다.
type SessionWalletContext = {
  walletAccountId: string;
  walletAddress: string;
  chainNamespace: 'solana';
};
function isSameParticipationWallet(saved: string, requested: string): boolean {
  return saved === requested;
}
```

### 검증과 완료 판정

같은 사용자 다른 지갑 재참가는 거절되고 기존 참가 row 불변. creator 자동 참가와 일반 참가 모두 walletAccountId/address 저장. 주소 대소문자를 바꿔 일치시키지 않는다.

실행 위치: backend.

```text
npm run test:nft && npm run typecheck
```

기대 결과: 인증 지갑과 참가 지갑이 DB로 연결되고 UI도 실제 activeWallet을 표시한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 새 시즌은 생성 시부터 참가 지갑이 고정된다. 데이터 삭제 스크립트 작성과 실제 실행은 구분해 보고한다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- auth_session의 walletAccountId는 authenticated 결과 최상위 필드다. user.id 등 기존 nested user는 유지한다. `/auth/me.activeWallet.id`는 이 walletAccountId다.
- wallet 조회는 session.user_id=wallet.user_id AND wallet.id=session.wallet_account_id AND chain_namespace='solana' 조건이다. 관계가 없으면 invalid, users.status가 기존 로그인 불가 상태이면 unavailable을 반환한다.
- create/join controller는 기존 인증 과정에서 받은 walletAccountId/address를 UseCase에 전달한다. 요청 body의 wallet 필드를 받지 않는다. 참가 INSERT는 기존 시즌 정원 검사·row lock 트랜잭션 안에서 실행한다.
- 지갑 mismatch는403, code `SEASON_PARTICIPATION_WALLET_MISMATCH`, message `Use the wallet that originally joined this season.`다. 같은 지갑의 이미 참가한 요청은 기존 idempotent 성공을 유지한다.
- user_wallets.address는 기존 고정 주소이며 참가 row에 복사한 주소와 같아야 한다. 신규 지갑 연결·복구 API를 추가하지 않는다.
- reset manifest는 schemaVersion=1, generatedAt, seasonIds, files[{imageKey,continuationKey}], countsBefore{users,wallets,mainCanvases,seasons,sessions}, databaseDeletionCommitted=false로 저장한다. DB commit 후 true로 atomic rewrite한다.
- cleanup-manifest는 DB에 manifest의 seasonIds가 더 이상 없는지 재검사하고 파일만 삭제한다. symlink 또는 realpath가 snapshot root 밖을 가리키면 파일 삭제를 거절한다. ENOENT는 정리 완료다.
- 삭제 transaction 직전 대상 season count와 NFT release 부재를 재확인한다. app/worker 중지는 운영 선행 조건이며 스크립트가 임의로 프로세스를 kill하지 않는다.
- migration은 reset을 실행하지 않는다. old session/participant가 남아 있으면 설명 가능한 예외로 중단한다. users/user_wallets/main canvas를 삭제하거나 전체 TRUNCATE CASCADE를 쓰지 않는다.
- 프론트 `/auth/me` fixture의 activeWallet 필드를 모든 관련 테스트에 추가한다. NFT 기능 false여도 신규 세션은 지갑 문맥을 가진다.

| 입력 | 저장 결과 | HTTP |
| --- | --- | --- |
| creator 정상 서명지갑A | creator 참가에A 저장 | 기존 생성 성공 |
| user의 지갑A로 재참가 | 기존 지갑A 유지 | 기존 참가 성공 |
| 같은 user 지갑B로 재참가 | row 변화 없음 |403 mismatch |
| 만료/구세션 | 참가 변화 없음 |401 AUTH_SESSION_INVALID |
| 다른 user의 wallet FK 직접 삽입 | DB rollback |23503 |


- 헤더뿐 아니라 ProfileContent의 지갑 주소도 session.activeWallet.address로 변경한다. wallets 배열 첫 주소와 로그인 주소가 다른 fixture에서 두 화면이 같은 activeWallet을 표시하는지 검증한다.

## 구현 검증 기록 — 2026-10-10

01.1과 01.2의 로컬 구현 및 교차 검토를 완료했다. 실제 개발 데이터 초기화와 배포 환경 migration은 실행하지 않았다.

- 백엔드: 실제 SIWS 서명 fixture로 로그인 지갑과 참가 지갑 전달을 검증했다. 지갑 연결 테스트 19개, NFT 테스트 39개, 기존 캔버스 테스트 63개가 통과했다. build, typecheck, lint, format 검사를 통과했다.
- 프론트엔드: login/me의 activeWallet 계약, 로그인 캐시, 헤더·연결 해제·프로필 표시를 반영했다. 전체 42개 파일의 248개 테스트와 build/lint/format이 통과했고, 연결 해제 주소 회귀 추가 후 해당 헤더 테스트 2개도 통과했다.
- 교차 검토: 초기화 manifest 복구의 완료 조건, 참가 지갑 ID·주소 일치 FK, release 존재·예상 시즌 수·주소 중복 방어 테스트를 수정 후 재검토했다. 원본 세 지적 모두 해소되었다.
- 추가 DB 제약: 참가 지갑 주소를 고정 주소와 일치시키기 위해 user_wallets(user_id,id,address) UNIQUE 및 참가자의 세 필드 FK를 적용한다.
- 배포 순서: 프론트엔드가 activeWallet을 필수로 소비하므로 백엔드를 먼저 반영하거나 함께 배포한다.
- 00의 Devnet·영구 저장 외부 검증은 별도이며 이 단계 통과로 대체하지 않는다.
