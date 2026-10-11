# 정상 종료 판정과 최종 이미지·수령 대상 확정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정상 종료한 시즌의 최종 이미지와 유효 기여자 명단을 한 번 확정한다.

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

- 선행 작업: **01·02 완료. Merkle SDK 연결은 LOCAL_SDK PASS 필요**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 12절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/canvas/resources/canvas-snapshot/final-canvas-snapshot-reader.ts`.
변경: `src/modules/canvas/canvas.module.ts`.
생성: `src/modules/season-nfts/features/prepare-season-nft/prepare-season-nft.use-case.ts`, `season-nft-candidates.query.ts`.
생성 테스트: `test/season-nft/freeze.test.cjs`, `test/season-nft/final-snapshot.test.cjs`.
기존 참조: canvas-snapshot.repository.ts, canvas-snapshot-files.ts, canvas-stroke-usage.repository.ts. NFT가 기존 파일 저장 규칙을 복제하지 않는다.

## 작업 03.1 — 최종 스냅샷 공개 reader

**인터페이스와 인계:** 입력: season canvas ID. 출력: `FinalCanvasSnapshotReader.read(canvasId: string): Promise<FinalSnapshot | null>`; FinalSnapshot은 아래 타입.

### 구현 순서

- [x] 1. FINAL+READY가 없으면 null, 다른 canvas 또는 head mismatch면 사용 불가, PNG 해시 불일치면 오류인 테스트를 작성한다.

- [x] 2. 기존 repository로 최종 snapshot을 조회하고 기존 파일 처리로 PNG bytes를 읽는다. path traversal과 static root 규칙을 재사용한다.

- [x] 3. 파일 I/O는 DB 트랜잭션 밖에서 수행한다. bytes의 SHA-256과 저장 hash, 크기를 대조한다.

- [x] 4. CanvasModule에서 reader만 export한다. NFT 모듈에 private snapshot repository를 export하지 않는다.


### 고정할 계약·핵심 구현

```ts
export type FinalSnapshot = {
  canvasId: string;
  snapshotId: string;
  throughSequence: bigint;
  pngBytes: Uint8Array;
  imageSha256: string;
  byteLength: bigint;
};
```

### 검증과 완료 판정

최종 이미지 없는 시즌은 대기. 같은 snapshot 메타데이터에 다른 PNG를 둔 경우 해시 오류. 다른 canvas의 snapshot 연결은 거절.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 기존 final snapshot을 검증해 읽고 별도 렌더러를 만들지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 03.2 — 자격·메타데이터 원본 freeze

**인터페이스와 인계:** 입력: reader 결과, 원본 usage/participants. 출력: PREPARING/FROZEN 또는 EMPTY release와 immutable claims.

### 구현 순서

- [x] 1. 정상 종료/강제 종료/취소/0명/미완료 chunk의 유효 usage fixture로 후보와 자격 테스트를 작성한다.

- [x] 2. 아래 후보 조건으로 release를 INSERT ON CONFLICT DO NOTHING한다. DB CURRENT_TIMESTAMP를 기준으로 판정한다.

- [x] 3. 트랜잭션 밖에서 PNG 검증과 SDK proof 계산용 자료를 읽는다. 트랜잭션 안에서 season/release를 잠그고 종료 조건·snapshot ID·head·명단을 다시 대조한다.

- [x] 4. 조회 사이 자료가 변했으면 commit하지 않고 다시 읽는다. 조건이 같을 때 frozen fields·count·claims·stage를 한 번에 저장한다.

- [x] 5. usage는 DISTINCT user_id이며 completed_at 필터를 쓰지 않는다. 참가 지갑 누락 또는 관계 불일치는 BLOCKED다.

- [x] 6. 명단 주소를 고정 순서로 정렬하고 검증된 SDK로 root/proof를 만든다. proof는 각 node를 32개 byte 정수 배열로 JSON 저장한다.

- [x] 7. 0명이면 EMPTY로 종료한다. 재시도는 frozen 결과를 재계산하거나 덮어쓰지 않는다.


### 고정할 계약·핵심 구현

```sql
SELECT c.id
FROM canvases c JOIN seasons s ON s.canvas_id = c.id
WHERE c.type = 'season' AND c.ends_at <= CURRENT_TIMESTAMP
  AND s.cancelled_at IS NULL AND s.force_ended_at IS NULL;
-- 자격 집계: completed_at 조건을 추가하지 않는다.
SELECT DISTINCT u.user_id, p.wallet_account_id, p.wallet_address
FROM canvas_stroke_usages u
LEFT JOIN season_participants p ON p.season_id = u.canvas_id AND p.user_id = u.user_id
WHERE u.canvas_id = $1
ORDER BY p.wallet_address COLLATE "C";
```

### 검증과 완료 판정

강제 종료 시즌은 원래 ends_at 이후에도 후보 아님. 첫 유효 획 하나면 eligible. freeze 직후 crash/retry에도 claim/root/hash 동일. 0명이면 storage/chain call 0.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 최종 snapshot sequence와 확정 head가 같고 대상 명단이 고정된다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 원본 12.2절의 파일 I/O와 DB 락을 분리하되 commit 직전 재검증으로 같은 불변 조건을 지킨다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- reader의 null은 final READY snapshot 미존재만 뜻한다. hash/크기 불일치·다른 canvas·최종head 불일치는 내부 오류이며 후보를 조용히 건너뛰지 않는다.
- `FinalSnapshot.throughSequence === BigInt(canvas.last_chunk_sequence)`를 검사한다. legacy last_sequence와 비교하지 않는다.
- final PNG 읽기 전에 image_bytes를 확인하고 실제 읽은 byte 수와 비교한다. 유효한 기존 snapshot을 재렌더링하지 않는다.
- release insert 시 network는 서버 설정에서만 읽는다. 정상 종료 후보 SQL에 `type='season'`, `ends_at<=CURRENT_TIMESTAMP`, `cancelled_at IS NULL`, `force_ended_at IS NULL`을 모두 사용한다.
- usage와 참가자 JOIN은 LEFT JOIN이어야 한다. 아래 결과에서 participant_user_id 또는 wallet_id/address가 NULL이면 BLOCKED다. 결과 배열 filter(Boolean)로 제거하지 않는다.

```sql
SELECT DISTINCT u.user_id, p.user_id AS participant_user_id,
       p.wallet_account_id, p.wallet_address,
       w.id AS verified_wallet_id, w.user_id AS wallet_user_id,
       w.address AS verified_address, w.chain_namespace
FROM canvas_stroke_usages u
LEFT JOIN season_participants p
  ON p.season_id = u.canvas_id AND p.user_id = u.user_id
LEFT JOIN user_wallets w ON w.id = p.wallet_account_id
WHERE u.canvas_id = $1;
```

- 자료 조회·PNG 검증·Merkle 계산은 lock 밖에서 수행한다. transaction 안에서는 season/release→snapshot/head→usage/participant 재조회 순서로 비교하고 같은 경우에만 freeze한다.
- 순서와 값 전체를 비교한다. count만 같고 주소가 바뀐 명단을 동일하다고 처리하지 않는다.
- count0이면 root는NULL, claims0행, image hash/size와snapshot 원본은 보존, image_uri/metadata_uri/온체인 주소는NULL, EMPTY/FROZEN이다. count1도 유효하며1명용 SDK proof를 검증한다.
- frozen 상태에서 원본 season.title이 바뀌어도 NFT 제목을 바꾸지 않는다. 이미 frozen 행은 read만 한다.

수령 자격 오류 코드는 내부 `NFT_ELIGIBILITY_CORRUPT`, head/hash 오류는 `NFT_FINAL_SNAPSHOT_INVALID`다. API에서는 둘 다PREPARING이다. 운영 로그에는 사용자 지갑 명단 대신 releaseId/불일치 종류만 기록한다.


## 구현 검증 기록 — 2026-10-10

03.1과03.2의 로컬 구현 및 교차 검토를 완료했다. 기존 final snapshot reader, 정상 종료 후보 조회, 전체 자격 재검증, SDK Merkle 이중 계산, atomic freeze를 연결했다. Snapshot 파일 오류는 결정적인 데이터 손상만 BLOCKED로 분류하며 일시적인 DB·파일 I/O 오류는 재시도할 수 있도록 전달한다. CAS 패배와 원본 변경은 RETRY, final 미존재는 DB 시간 기준60초 후 재확인이다.

- 검증: `npm run test:nft` 88/88, `npm run test:realtime` 63/63, reader/freeze/repository 집중 테스트39/39 통과. typecheck, lint, format:check, git diff --check 통과.
- 독립 리뷰의 두 지적(일시적 파일 오류 분류, Merkle 이중 계산 누락)을 수정했고 재검토에서 spec/quality PASS, 미해결 지적0건을 확인했다. Root도 변경 코드와 회귀 테스트를 대조했다.
- 구현 보고서: `/private/tmp/season-nft-03-report.md`; 최종 재검토: `/private/tmp/season-nft-03-fix1-review.md`; 검토 snapshot: `/private/tmp/season-nft-03-fix1-review.diff`. 임시 검토 파일은 실행에 필요한 영구 문서가 아니다.
- 후속 작업은 `PrepareSeasonNftUseCase.execute`와 `SeasonNftCandidatesQuery`를 사용하고 `next_attempt_at` 및 RETRY/BLOCKED/EMPTY 결과를 구분한다. 확정 snapshot ID·head·hash·byte length와 claim/root/proof를 재계산하거나 교체하지 않는다.
- 실제 개발 DB 초기화, 외부 업로드·체인 거래, 배포, commit/push는 수행하지 않았다. 00의 CHAIN_AUTHORITY/STORAGE_RECOVERY는 여전히 NOT_RUN이며03 로컬 완료와 구분한다.
