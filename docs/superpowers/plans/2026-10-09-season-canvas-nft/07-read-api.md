# 시즌 NFT 조회와 프로필 참여 시즌 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인증 사용자의 NFT 상태와 실제 참여 시즌 목록을 API로 제공한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 **로컬 구현·교차 검토 완료** 상태다. 체크박스는 실제 HTTP·DB 구현 검증 범위를 나타낸다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **01·02 완료. fixture로 구현 가능**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 14절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/season-nfts/features/get-season-nft/get-season-nft.controller.ts`, `get-season-nft.use-case.ts`.
생성: `src/modules/seasons/features/list-participated-seasons/list-participated-seasons.controller.ts`, `list-participated-seasons.use-case.ts`, `participated-seasons.query.ts`.
생성: `src/modules/season-nfts/resources/season-nft/season-nft-view.ts` — SeasonNftView 타입과 조회 상태 해석 공유.
변경: 각 소유 module 등록. response model은 feature 폴더에 둔다.
생성 테스트: `test/season-nft/read-api.test.cjs`.
SeasonsModule의 query가 NFT DB read model을 JOIN하는 것은 허용하되 NFT 준비 UseCase를 호출하지 않는다.

## 작업 07.1 — 인증 사용자별 NFT 상태

**인터페이스와 인계:** 입력: session userId, seasonId, DB lifecycle/usage/claim. 출력: 원본 14.1절 SeasonNftView envelope.

### 구현 순서

- [x] 1. 정상 종료 전·취소·강제 종료·disabled·준비·EMPTY·READY·CLAIMED fixture로 상태 우선순위 테스트를 작성한다.

- [x] 2. 취소/강제 종료는 UNAVAILABLE, 일반 정상 종료 전은 WAITING_FOR_END로 해석한다. disabled의 reason은 FEATURE_DISABLED다.

- [x] 3. 기여 여부는 서버 usage와 참가 레코드로 판정한다. 다른 사용자의 claim을 조인하지 않는다.

- [x] 4. BLOCKED는 PREPARING으로 공개하고 provider 오류·키 경로를 숨긴다. claim receipt RESOLVING은 완료이지만 asset/signature가 null일 수 있다.

- [x] 5. 기존 응답 envelope·인증·오류 필터를 재사용한다. 응답 DTO에 nullable과 enum을 Swagger로 선언한다.


### 고정할 계약·핵심 구현

```json
{
  "statusCode": 200,
  "success": true,
  "data": {
    "seasonId": "00000000-0000-4000-8000-000000000001",
    "network": "devnet", "availability": "PREPARING", "reason": null,
    "name": null, "imageUrl": null, "metadataUri": null, "eligibleCount": null,
    "claim": {
      "eligibility": "NOT_PARTICIPANT", "state": "UNCLAIMED", "walletAddress": null,
      "activeAttemptId": null, "assetAddress": null, "signature": null,
      "receiptState": "NONE", "claimedAt": null
    }
  }
}
```

### 검증과 완료 판정

같은 seasonId를 두 세션에서 조회하면 각 사용자 claim만 반환. 없는 시즌404, 무인증401. 내부 last_error_message는 body에 없음.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 프론트가 자체 획 수나 minted flag로 자격을 추정할 필요가 없다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 07.2 — 실제 참여 시즌 목록

**인터페이스와 인계:** 입력: userId, limit=20/offset=0. 출력: 원본 14.5절 ParticipatedSeasonItem 목록.

### 구현 순서

- [x] 1. 자동 참가한 개설자·종료 시즌·다른 사용자·동일 joined_at fixture를 만든다.

- [x] 2. 정적 /seasons/participated route를 동적 UUID route보다 충돌 없이 등록한다. validation은 limit1..50, offset>=0 정수다.

- [x] 3. participation을 기준으로 usage count와 final snapshot, 현재 network의 NFT release/claim을 JOIN한다. joined_at DESC,season_id DESC로 정렬한다.

- [x] 4. 목록 total은 같은 사용자 조건의 전체 수이며 페이지 길이가 아니다. 결과가 없으면 items=[] total=0이다.

- [x] 5. RPC와 외부 storage 호출 없이 DB 조회만 수행한다. 기존 lifecycle 타입의 실제 export를 사용하고 새 enum을 만들지 않는다.


### 고정할 계약·핵심 구현

```sql
-- 페이징의 기준. 결과 projection에 원본 14.5절 필드만 포함한다.
SELECT p.season_id, p.joined_at
FROM season_participants p
WHERE p.user_id = $1
ORDER BY p.joined_at DESC, p.season_id DESC
LIMIT $2 OFFSET $3;

```

### 검증과 완료 판정

limit0/51/1.5와 offset-1은400. creator 포함·종료 시즌 포함·타인 제외. 같은 시각 항목은 season_id 순서 고정. RPC spy0회.

실행 위치: backend.

```text
npm run test:nft && npm run typecheck
```

기대 결과: profile 샘플을 대체할 실제 API가 준비된다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: HTTP 계약은 Swagger가 구현 기준이다. 원본 상세 명세를 docs/api에 다시 복사하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- `SeasonNftView` 타입은 `resources/season-nft/season-nft-view.ts` 한 곳에서 정의한다. list query가 type-only import할 수 있으나 SeasonsModule이 SeasonNftsModule의 준비 provider를 import하지 않는다.
- lifecycleStatus의 실제 값은 scheduled/active/ended/cancelled다. FORCE_ENDED는 lifecycle enum에 추가하지 않고 nft.reason에서 구별한다.
- availability/eligibility/nullable field 우선순위는 구현 결정 계약7절이 최종 기준이다. API 테스트는 각 조합의 exact JSON shape를 검사한다.
- 이미 CLAIMED인 사용자는 기능 disabled에서도 기존 수령 증거를 조회한다. disabled를DB 조회 자체의503으로 바꾸지 않는다.
- GET이 release를 새로 만들거나 nft 준비 작업을 enqueue하지 않는다. 후보 worker가 시작되지 않았어도 응답 가능해야 한다.
- 참가했지만 claim이 아직 freeze되지 않은 사용자의 walletAddress는 season_participants.wallet_address다. null로 숨기지 않는다.
- GET /seasons/participated는 auth 적용 후 정적 route로 매칭한다. seasonId UUID parser가 'participated'를 잘못400으로 처리하지 않는 e2e를 넣는다.
- unknown query field는 기존 validation 정책을 따르고 limit/offset은 숫자 문자열을 정수로 명시 변환한다. 빈문자열·NaN·소수·범위 밖은400이다.
- ownStrokeCount는 해당 user/canvas usage 행 수다. JOIN 중 claim/transaction 다중 행으로 집계가 부풀지 않도록 usage를먼저 group한다.
- total과 items는 동일 사용자 조건이다. 다른 사용자의 지갑·명단·claim 수를 응답하지 않는다. eligibleCount는 시즌 공통 총인원만 보여준다.

테스트 우선순위 예: 취소+disabled는 UNAVAILABLE/CANCELLED, 강제종료+기한경과는 UNAVAILABLE/FORCE_ENDED, 정상종료+BLOCKED는 PREPARING/null, 정상종료+EMPTY는 EMPTY/null, READY+counter확인중 수령은 CLAIMED/RESOLVING이다.


### 조회 network 미설정 처리

기능 disabled와 network 미설정은 구별한다. 유효한 `SOLANA_NETWORK`가 있으면 disabled에서도 조회와 기존 수령 증거를 제공한다. network가 없으면 인증을 먼저 검사하고 두 조회 API에 기존 `NFT_SERVICE_UNAVAILABLE`(503)을 반환한다. 임의 기본 network나 DB 추론으로 다른 환경의 정보를 보여주지 않는다. Swagger에는 필수 설정 장애의 503을 선언하고, 테스트는 disabled+valid network의 200, authenticated+missing network의 503, unauthenticated+missing network의 401을 구분한다. 기존 disabled 부팅의 외부 I/O 금지는 유지한다.

## 구현 검증 기록 — 2026-10-10

- 인증 필수 `GET /api/seasons/:seasonId/nft`와 `GET /api/seasons/participated`를 구현했다. controller/use case/query/response model과 module 등록을 추가했다.
- 공유 `SeasonNftView` projection은 공개 상태 우선순위, 사용자별 참가 지갑·usage·claim, nullable receipt 필드를 처리한다. 내부 오류를 노출하지 않고, disabled에서도 기존 수령 정보를 보존한다.
- 참여 목록은 사용자 usage를 먼저 집계하며 total과 page를 동일 READ COMMITTED transaction에서 조회한다. 정적 route를 UUID route보다 먼저 등록하고 final READY snapshot만 preview로 사용한다.
- `NFT_SERVICE_UNAVAILABLE`의 정확한 공개 정의만 공통 오류 필터에서 허용한다. network 미설정은 인증 후 503이며, disabled+유효 network는 200이다.
- 실제 Nest HTTP·Docker PostgreSQL 테스트 7/7, 전체 NFT 169/169, realtime 63/63, build·typecheck·lint·format·diff 검사 통과. RPC spy 호출 0회다.
- root와 독립 리뷰어의 source·SQL·테스트·Swagger 교차 검토를 통과했으며 남은 Critical/Important 지적은 없다.
- 08은 동일 claim 조회 계약을 유지하고 09는 Swagger의 두 GET 응답을 소비한다. 코드 commit·push·배포는 수행하지 않았다.
- 외부 CHAIN_AUTHORITY와 STORAGE_RECOVERY는 NOT_RUN이다. 이 단계의 DB 조회 검증은 외부 발행 검증을 대신하지 않는다.
