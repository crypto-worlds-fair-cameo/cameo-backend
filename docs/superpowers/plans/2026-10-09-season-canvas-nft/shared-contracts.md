# 시즌 NFT 공통 실행 계약

이 파일은 각 작업 문서와 함께 읽는다. 신규 기능을 작성하기 전에 두 저장소의 AGENTS.md와 변경 상태를 확인한다. 원본 정책은 [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md)을 따른다.

## 저장소와 변경 범위

- Backend: `/Users/simon.choi/work-space/solanaton/backend`.
- Frontend: `/Users/simon.choi/work-space/solanaton/frontend`.
- backend 계획 문서가 frontend 변경 권한을 뜻하지는 않는다. 실행 환경에서 해당 저장소 접근이 없으면 변경할 파일과 검증을 인계한다.
- 기존 사용자 변경을 되돌리지 않는다. 이 계획 작성 시점에는 앱 코드·DB·키·외부 계정을 변경하지 않았다.
- 신규 DB migration 이름이 실행 시점에 충돌하면 다음 유일한 정렬 이름을 사용하고 참조를 갱신한다. 적용된 migration을 덮어쓰지 않는다.

## 상태 및 표현

| 구분 | 허용값 |
| --- | --- |
| network | devnet, mainnet-beta |
| release state | WAITING_SNAPSHOT, PREPARING, READY, EMPTY, BLOCKED |
| release stage | SNAPSHOT, FROZEN, IMAGE, METADATA, COLLECTION, MACHINE, LOCKED |
| claim state | UNCLAIMED, PROCESSING, CLAIMED |
| receipt state | NONE, RESOLVING, VERIFIED |
| attempt state | QUEUED, AWAITING_SIGNATURE, SUBMITTING, CONFIRMING, SUCCEEDED, EXPIRED, FAILED |
| attempt step | ALLOWLIST_PROOF, MINT |
| transaction state | PREPARED, SIGNED, SUBMITTED, CONFIRMED, FINALIZED, RECONCILED, FAILED, EXPIRED |
| upload state | PREPARED, UPLOADED, VERIFIED, FAILED |

- bigint는 DB/서버 내부 정수이며 JSON은 십진 문자열이다. 날짜는 UTC ISO8601이다.
- 주소는 대소문자를 보존한다. wallet_account_id는 내부 UUID, wallet_address는 Solana 주소다.
- timeout/429는 FAILED의 근거가 아니다. signed tx는 동일 바이트·signature로 재전송한다.
- counter1이면 CLAIMED다. asset/signature 확인이 늦으면 RESOLVING이며 새 발행을 허용하지 않는다.
- API `SeasonNftView`, `ClaimAttemptView`, `ParticipatedSeasonItem`의 정확한 필드는 원본 14절이다. 계획마다 새 응답 타입을 만들지 않는다.
- lifecycle은 backend `season-state.ts`와 frontend `seasons.types.ts`의 `SeasonStatus`이며 값은 scheduled/active/ended/cancelled다.

## 모듈 간 인계

| 제공 작업 | 제공 계약 | 소비 작업 |
| --- | --- | --- |
| 00 | SDK 버전·실제 exports·권한 잠금/업로드 복구 실행 코드·증거 | 03,04,06,08 |
| 01 | SessionAuthenticationResult의 지갑 문맥, activeWallet, 참가 고정 지갑 | 03,07,08,09 |
| 02 | 5개 상태 테이블·CAS·unique/fk·operation_key | 03~08 |
| 03 | FinalSnapshot, FROZEN release/claims/root/proof | 04,06 |
| 04 | VERIFIED image/metadata URI와 hash | 06 |
| 05 | shared scheduler, dispatcher, canExpire, DB leader lifecycle | 06,08 |
| 06 | finalized LOCKED/READY 및 고정 온체인 주소 | 07,08 |
| 07 | 인증 NFT 상태·실제 참여 목록 API | 09 |
| 08 | 생성·조회·서명 제출 API, finalized 수령 상태 | 09,10 |
| 09 | 공통 카드와 실제 profile 연결 | 10,11 |
| 10 | preflight/reset/retry 명령, runbook, Devnet 증거 | 11 |

Repository 내부 메서드의 인자와 SQL은 해당 소유 작업이 정한다. 다른 작업은 DB 스키마와 위 공개 capability/UseCase 계약에 의존한다. private repository를 다른 모듈에 무분별하게 export하지 않는다.

## 테스트 실행 기반

00보다 독립 작업을 먼저 수행하고 test:nft가 아직 없으면 아래 package script를 그 작업에서 추가한다. 00이 이후 동일 이름을 덮어 다른 의미로 바꾸지 않는다.

```json
{
  "test:nft": "npm run build && node --test --test-concurrency=1 test/season-nft/*.test.cjs"
}
```

기존 backend 테스트는 Node test runner의 CJS에서 dist를 읽는다. 새 테스트도 같은 방식을 사용하고 별도 Jest 설치를 하지 않는다. 예를 들어 04의 metadata 테스트는 다음과 같이 시작한다.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAssetName,
  serializeSeasonMetadata,
} = require('../../dist/modules/season-nfts/resources/nft-media/season-nft-metadata');

test('name fits UTF-8 limit without breaking characters or expanding IDs', () => {
  const name = buildAssetName('$ID$' + '가😀'.repeat(30));
  assert.ok(Buffer.byteLength(name, 'utf8') <= 32);
  assert.equal(name.includes('$'), false);
  assert.equal(name.includes('�'), false);
});

test('metadata serialization is deterministic and excludes personal fields', () => {
  const input = {
    seasonId: '00000000-0000-4000-8000-000000000001',
    title: '함께 그린 그림', description: null,
    endedAt: '2026-10-09T01:00:00.000Z', contributors: 2,
    imageUri: 'https://example.invalid/immutable-image', imageSha256: 'a'.repeat(64),
  };
  const first = Buffer.from(serializeSeasonMetadata(input));
  assert.deepEqual(first, Buffer.from(serializeSeasonMetadata(input)));
  const metadata = JSON.parse(first.toString('utf8'));
  assert.equal(metadata.description, 'A collaborative canvas completed on Cameo.');
  assert.deepEqual(Object.keys(metadata), ['name', 'description', 'image', 'attributes', 'properties']);
  assert.deepEqual(metadata.attributes.map((a) => a.trait_type),
    ['Season ID', 'Season Title', 'Ended At', 'Contributors', 'Image SHA256']);
  assert.equal(metadata.image, input.imageUri);
});
```

05의 만료 테스트는 불명확한 체인 상태에서 새 거래를 만드는 회귀를 막는다.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canExpire } = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');

test('expiry requires final height and complete negative evidence', () => {
  const e = {
    finalizedHeight: 101n, lastValidBlockHeight: 100n,
    signature: 'ABSENT', accountEvidence: 'ABSENT', allQueriesSucceeded: true,
  };
  assert.equal(canExpire(e), true);
  assert.equal(canExpire({ ...e, finalizedHeight: 100n }), false);
  assert.equal(canExpire({ ...e, signature: 'CONFIRMED' }), false);
  assert.equal(canExpire({ ...e, accountEvidence: 'SUCCESS' }), false);
  assert.equal(canExpire({ ...e, accountEvidence: 'UNKNOWN' }), false);
  assert.equal(canExpire({ ...e, allQueriesSucceeded: false }), false);
});
```

DB 테스트는 `test/canvas/database-fixture.cjs`의 `testDatabaseModule()`을 재사용한다. 이 함수가 migration을 이름순 적용한 임시 PostgreSQL과 pool을 제공한다. 운영 DATABASE_URL을 테스트 대상으로 사용하지 않는다.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');

test('NFT migrations create all five persistence tables', async () => {
  const { pool } = await testDatabaseModule();
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (
      'season_nft_releases', 'season_nft_claims', 'season_nft_claim_attempts',
      'season_nft_transactions', 'season_nft_uploads'
    ) ORDER BY table_name
  `);
  assert.equal(result.rows.length, 5);
});
```

위 migration smoke test만으로 schema 작업을 완료하지 않는다. 02에 명시한 FK/UNIQUE/READY 제약과 실제 concurrent connection 테스트가 필수다. 새 NOT NULL 지갑 필드 때문에 기존 auth/season fixture가 깨지면 그 fixture 생성 함수를 함께 수정한다. 실제 SIWS 검증은 기존 로그인 테스트 흐름을 재사용하며 auth를 mock한 HTTP 테스트만으로 인증을 완료 처리하지 않는다.

- 실패 확인: 필요한 symbol 또는 행위가 아직 없어서 기대한 테스트가 실패하는지 본다. fixture 설치 오류·DB 실행 불가를 의도한 실패로 세지 않는다.
- 구현 후 해당 테스트를 통과시키고 타입·관련 회귀 검사를 실행한다.
- 외부 실비가 필요한 검증은 일반 test:nft에 섞지 않는다. 실제 Devnet 명령은 00, Mainnet 인수는11이다.
- frontend는 기존 Vitest/Testing Library를 사용한다. `npm run test` 자체가 vitest run이므로 별도 watch 종료가 필요 없다.

## 계획을 구체화하며 추가한 구현 결정

아래는 새로운 제품 정책이 아니라 원본의 빈 구현 세부를 확정한 것이다.

1. 임시 준비 키 파일 식별자는 releases.preparation_keys JSONB에 저장한다. 실제 키 파일은0700/0600 지속 저장소에 보관한다.
2. upload 상태는 PREPARED/UPLOADED/VERIFIED/FAILED로 제한한다.
3. 동일 operation_key의 진행 중·FINALIZED·RECONCILED 거래를 하나의 partial UNIQUE로 보호한다. 성공 효과가 확인되면 신규 거래 생성을 거절한다.
4. final PNG I/O는 락 밖에서 수행하고 freeze commit 직전에 snapshot/head/명단을 다시 검증한다. 읽기와 commit 사이 변경은 재시도한다.
5. 최초 받기 클릭은 거래 준비를 접수한다. 실제 서명은 비용이 표시된 AWAITING_SIGNATURE 단계에서 별도 클릭으로 시작한다.
6. 사용자 거래 비용 추정은 transactions.estimated_cost_lamports/estimated_at에 영속화하여 서명 대기 조회에 재사용한다.
7. metadata attributes는 표준 trait_type/value 객체 배열이고 순서는 테스트 예제와 동일하다.

## 인계 기록 형식

아래 양식을 실제 작업 결과로 채운다. 빈 항목은 완료로 취급하지 않는다.

```markdown
### 작업 번호 및 제목
- 상태: NOT_STARTED / IN_PROGRESS / LOCAL_VERIFIED / EXTERNAL_VERIFIED / EXTERNAL_VALIDATION_PENDING / BLOCKED_TECHNICAL
- 변경 파일:
- 공개 계약 변경:
- 실행한 명령과 결과:
- 실패/재시작 검증:
- 실제 외부 실행 증거:
- 수행하지 못한 검증과 이유:
- 다음 작업 입력:
```

계획 작성 시 외부 실행 증거는 없다. 명령이 문서에 존재한다는 이유로 그 명령이 현재 구현되어 있다고 주장하지 않는다.

## revision 2의 확정 규칙

[구현 결정 계약](implementation-contract.md)이 상태 전이·DB 제약·API 응답 우선순위·재시도 수치·운영 명령의 구체적 기준이다. 각 작업 파일에 추가한 확정 실행 상세와 함께 적용한다. RECONCILED는 성공 효과만 확인되고 정확한 거래 증거는 복구 중인 내부 transaction 상태이며, FINALIZED 증거를 위조하는 의미가 아니다.
