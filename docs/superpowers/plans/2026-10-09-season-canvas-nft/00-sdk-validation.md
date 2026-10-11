# SDK 호환성 및 권한 잠금 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실제 SDK와 Devnet 실행으로 잠금 후 민팅·불변성·재시도 호환성을 검증한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 **미실행 작업 명세**다. 체크박스는 실제 구현·검증 후에만 체크한다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **없음**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 9절, 12절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `scripts/season-nft/verify-devnet.cjs`, `test/season-nft/sdk-contract.test.cjs`, `docs/deployment/season-nft-sdk-evidence.md`.
변경: `package.json`, `package-lock.json`.
검증 산출물: 네트워크·SDK 버전·프로그램 주소·검증 시각·거래 signature·검증 결과 JSON. 비밀키와 signed bytes는 포함하지 않는다.

## 작업 00.1 — SDK 설치 계약과 검증 명령

**인터페이스와 인계:** 입력: 현재 Node/TS 및 원본 9·12절. 출력: 고정 버전 lockfile, `npm run test:nft`, `npm run nft:verify:devnet`. 운영 API는 추가하지 않는다.

### 구현 순서

- [x] 1. 현재 package.json의 Node >=24.21.0 <25와 TS 설정을 읽고 SDK의 exports·peerDependencies를 확인한다. Umi/Core/Core Candy Machine/Turbo의 실제 호환 버전을 고정한다.

- [x] 2. 선택한 SDK에서 collection 생성, machine/guard 생성·수정, proof route, mint, counter/proof 조회, 권한 변경 API를 import하는 sdk-contract 테스트를 먼저 작성한다.

- [x] 3. 설치되지 않은 export 때문에 실패하는지 확인하고 실제 export로 구현한다. 문서의 V2 함수 이름을 검증 없이 복사하지 않는다.

- [x] 4. 아래 scripts를 추가한다. test:nft는 네트워크 없이 실행하며 Devnet 실행은 별도 명령으로 분리한다.

- [x] 5. 검증 스크립트는 SOLANA_NETWORK=devnet을 강제하고 mainnet-beta 입력을 거절한다. 외부 계정이 없으면 미실행으로 기록한다.


### 고정할 계약·핵심 구현

```json
{
  "test:nft": "npm run build && node --test --test-concurrency=1 test/season-nft/*.test.cjs",
  "nft:verify:devnet": "npm run build && node scripts/season-nft/verify-devnet.cjs"
}
```

### 검증과 완료 판정

sdk-contract.test.cjs에서 필요한 SDK export가 함수인지, 거래 직렬화와 public key/서명 타입이 현재 빌드에서 통합되는지 검사한다. 런타임 import 실패를 skip으로 숨기지 않는다.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: SDK import·빌드 통과. 실제 발행 검증은 이 결과에 포함하지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 00.2 — 권한 잠금 뒤 실제 발행 검증

**인터페이스와 인계:** 입력: 2개 허용 지갑, 외부 지갑 1개, devnet 서비스 지갑. 출력: `docs/deployment/season-nft-sdk-evidence.md`의 PASS/FAIL/NOT_RUN 증거. 후속 04·06·08 작업의 SDK 호출 근거.

### 구현 순서

- [x] 1. 스크립트에 시나리오별 assertion을 먼저 작성한다. 아래 결과 키 전부를 기록하고 하나라도 실패하면 종료 코드 1로 끝낸다.

- [ ] 2. 2명 allowlist·mintLimit id=0 limit=1·같은 metadata로 Collection/Machine/Guard를 만든다. 12.4절 순서로 관리 권한을 잠근다.

- [ ] 3. 잠금 후 허용 지갑 둘의 민팅, 비허용 지갑 거절, 재민팅 거절, 관리자 name/URI/root/수량 변경 거절을 실제 거래로 검사한다.

- [ ] 4. 첫 자산 전송 후 원래 지갑의 재민팅이 거절되는지 검사한다. 가능한 테스트 자산으로 소각 후 counter 유지도 검증한다.

- [x] 5. 100명 Merkle proof의 등록 및 mint 거래를 직렬화해 각각 1232 bytes 이하인지 확인한다. proof와 mint를 분리한다.

- [ ] 6. Turbo의 signed data item을 파일에 저장하고 재로딩·동일 ID 재사용 가능한 실제 API를 확인한다. 영구 업로드와 sandbox를 구분한다.

- [ ] 7. 사용한 정확한 SDK 함수·인자·권한 변경 순서·delegate 유지 조건을 실행 코드와 증거 문서에 남긴다. 실패하면 대안을 이 계획과 원본에 반영하기 전 후속 온체인 구현을 진행하지 않는다.


### 고정할 계약·핵심 구현

```js
const required = [
  'mintAfterLock', 'outsiderRejected', 'secondMintRejected',
  'nameChangeRejected', 'uriChangeRejected', 'rootChangeRejected',
  'supplyChangeRejected', 'transferWorks', 'remintAfterTransferRejected',
  'proofFits100', 'mintFits100', 'uploadItemRestoresSameId',
  'remintAfterBurnRejected', 'assetMetadataChangeRejected', 'collectionChangeRejected',
  'mintAuthorityChangeRejected', 'noBypassGuardGroup', 'payerIsRecipient',
  'feeEstimateMatchesInstructions', 'permanentUploadRetrievable'
];
function assertEvidence(results) {
  for (const key of required) {
    if (results[key] !== 'PASS') throw new Error(`Unverified: ${key}`);
  }
}
```

### 검증과 완료 판정

각 실패 거래의 실제 program error와 signature를 기록한다. 프로그램 실패가 아니라 RPC timeout이면 거절 검증 성공으로 세지 않는다.

실행 위치: backend.

```text
SOLANA_NETWORK=devnet npm run nft:verify:devnet -- --execute --json
```

기대 결과: 모든 요구 결과 PASS. 자금·키 부재는 NOT_RUN이며 이 단계 완료로 기록하지 않는다.

- [ ] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [ ] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: SDK·권한·업로드 재시도 계약을 실제로 검증했다. 독립 구현은14절의 LOCAL_SDK/CHAIN_AUTHORITY/STORAGE_RECOVERY별 게이트를 따른다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- 설치 후보는 `@metaplex-foundation/umi`, `@metaplex-foundation/umi-bundle-defaults`, `@metaplex-foundation/mpl-core`, `@metaplex-foundation/mpl-core-candy-machine`, Turbo 공식 SDK다. 00 실행 시 npm registry의 stable 버전만 대상으로 선택한다.
- 선택 순서: Candy Machine stable 최신부터 내림차순→각 버전 peerDependencies 교집합→기존 Node/TS 빌드 통과 조합. prerelease, --force, --legacy-peer-deps는 사용하지 않는다. 첫 호환 조합의 버전을 exact string으로 저장하고 package-lock을 커밋 대상에 포함한다.
- 검증 adapter의 소유 파일은 `scripts/season-nft/sdk-validation.cjs`다. 동적 import가 필요한 SDK는 이 파일에서만 처리한다. 검증이 끝난 호출을06/08의 실제 provider로 옮긴다.
- fixture 지갑은 서비스/허용A/허용B/비허용C 총4개이며 테스트 전용이다. 비밀키는 NFT_PREPARATION_KEY_DIR의 devnet-validation 하위에0600으로 저장한다. 운영 지갑을 소각·전송 실패 테스트에 재사용하지 않는다.
- `npm run nft:verify:devnet -- --execute --json`이 실제 mutation 검증 명령이다. `--execute` 없으면 계획과 미입력 설정만 출력한다. mainnet-beta에서는 인자와 관계없이 exit2다.
- `docs/deployment/season-nft-sdk-evidence.json`을 생성한다. 필드: schemaVersion=1, checkedAt, network, gitCommit, packages(이름→정확 버전), programAddresses, tests(아래 결과), overallStatus다. 키·전체 RPC URL·signed bytes는 없다.
- 각 test는 `{id,status:'PASS'|'FAIL'|'NOT_RUN',signatures:string[],reason:string|null}`다. assertion에서 PASS 아닌 항목은 통과로 세지 않는다. 서명 전 simulation으로 거절을 확인한 경우 signature=[]이며 program error와 simulation evidence를 reason에 기록한다.
- 필수 test에는 기존12개 외 `remintAfterBurnRejected`, `assetMetadataChangeRejected`, `collectionChangeRejected`, `mintAuthorityChangeRejected`, `noBypassGuardGroup`, `payerIsRecipient`, `feeEstimateMatchesInstructions`, `permanentUploadRetrievable`를 추가한다.
- 잠금 주소 derivation, 관리 authority와 mint authority, plugin authority/delegate를 각각 기록한다. off-curve라는 문자열 검사만으로 서명 불가능성을 증명했다고 하지 않는다.
- 생성·잠금 거래가1232bytes를 넘으면 준비 단계를 여러 substep으로 나누되 Start Date 차단을 끝까지 유지한다. **차단 제거+Guard 관리 authority 잠금은 동일 마지막 거래**여야 한다. machine/collection은 차단 상태에서 먼저 잠근다. 이 순서로 동작하지 않으면 실패로 처리한다.
- SDK가 요구하는 program address는 설치 패키지에서 추출하고 공식 배포 주소와 비교한다. 이름이 비슷한 Token Metadata Candy Machine을 섞지 않는다.

| 검증 실패 | 질문 없이 할 일 | 완료 판정 |
| --- | --- | --- |
| package import/peer 충돌 | 같은 stable 후보 탐색 순서로 다음 조합 검사 | 첫 통과 조합 고정 |
| RPC429/timeout | 공통 backoff로 재조회 | timeout을 거절 성공으로 세지 않음 |
| 잔액·키·storage 입력 없음 | 명령·필요 env·NOT_RUN 증거 저장, 독립 로컬 작업 계속 | EXTERNAL_VALIDATION_PENDING |
| 잠금 후 민팅 불가/불변성 우회 가능 | 실제 실패 로그와 최소 재현 저장 | BLOCKED_TECHNICAL; 체인 의존 작업 중지 |

새 파일이나 테스트만으로00 전체를 완료하지 않는다. overallStatus는 LOCAL_VERIFIED, EXTERNAL_VALIDATION_PENDING, EXTERNAL_VERIFIED, BLOCKED_TECHNICAL 중 하나다. 모든 필수 tests가 실제 PASS일 때만 EXTERNAL_VERIFIED다.


## 독립 검증 게이트

evidence JSON에 `gates: {LOCAL_SDK, CHAIN_AUTHORITY, STORAGE_RECOVERY}`를 추가하고 값은PASS/FAIL/NOT_RUN이다. 각 tests에 gate를 지정한다. import·버전·proofFits100/mintFits100은LOCAL_SDK, uploadItemRestoresSameId/permanentUploadRetrievable은STORAGE_RECOVERY, 나머지 실제 chain 검증은CHAIN_AUTHORITY다. 전체 summary 미완료가 독립 작업 중지의 근거는 아니다. 구현 결정 계약14절의 작업별 게이트를 적용한다.

## 구현 검증 기록 — 2026-10-10

상태: **EXTERNAL_VALIDATION_PENDING**. 00.1 로컬 SDK 계약과 00.2 실행 도구의 로컬 구현을 교차 검토했다. 00.2 실제 외부 실행은 완료하지 않았다.

- 고정 버전: mpl-core-candy-machine 0.3.0, mpl-core 1.10.0, umi/umi-bundle-defaults 0.8.10, @ardrive/turbo-sdk 2.1.0. peer 충돌 우회 옵션 없이 dependency tree를 확인했다.
- SDK 테스트 24개 통과. 실제 SDK builder의 서명·직렬화·역직렬화, 100명 proof 크기, 상태 증거 검증, 동일 거래 재전송 및 소각 후 checkpoint 복구를 포함한다. 최초 검증의 proof 548 bytes, mint 647 bytes로 1232 bytes 이하다.
- 교차 검토 지적을 수정했다: Core burn tombstone, 비용 구성별 simulation/receipt 비교, 잘못된 상태값의 PASS 차단, 동일 바이트 재시작 복구, 절대 경로 검사, 권한 관측 증거 및 거래 서명 귀속.
- 검증 결과는 [SDK 증거 문서](../../../deployment/season-nft-sdk-evidence.md)와 [JSON](../../../deployment/season-nft-sdk-evidence.json)에 기록한다. LOCAL_SDK=PASS, CHAIN_AUTHORITY=NOT_RUN, STORAGE_RECOVERY=NOT_RUN이다.
- 실제 Devnet/Turbo 실행, 자금 사용, Mainnet 발행은 수행하지 않았다. 해당 게이트를 요구하는 후속 실제 연동 검증은 별도로 남아 있다.
- 의존성 보안 점검 결과와 남은 위험은 SDK 증거 문서에 기록했다. dependency tree 통과를 취약점 없음으로 해석하지 않는다.

### Core Candy Machine의 필수 Collection delegate

- Machine 생성 전에는 Collection에 `ImmutableMetadata`만 존재한다. Machine 생성 후에는 SDK가 설치한 `UpdateDelegate`도 반드시 존재해야 한다.
- `UpdateDelegate.authority.type`은 `UpdateAuthority`, `additionalDelegates`는 해당 Machine 주소로 `findCandyMachineAuthorityPda`를 호출해 계산한 PDA 하나와 정확히 같아야 한다. 누락, 다른 주소, 추가 주소, 다른 delegate plugin은 거절한다.
- Collection 관리 권한을 lock PDA로 이전해도 이 발행 delegate는 유지한다. Collection의 delegate가 비어 있어야 한다는 검증은 적용하지 않는다. 민팅된 개별 Asset에 delegate가 없어야 한다는 기존 조건은 유지한다.
- finalized readback과 setup 거래 복구에 동일한 조건을 적용한다. SDK evidence에는 `collectionMintDelegate`의 expected PDA, actual 주소 배열, authorityKind를 기록한다.

### Collection 메타데이터 잠금의 실행 조건

`ImmutableMetadata`는 Collection의 이름·URI뿐 아니라 update authority 변경도 거절한다. 따라서 `setup:lock:1`은 `removeCollectionPlugin(ImmutableMetadata)`와 `updateCollectionV1(newUpdateAuthority=lock PDA, newName=None, newUri=None)`를 **하나의 Solana 거래**로 실행한다. 둘 중 하나라도 실패하면 모두 롤백된다. 이 시점까지 Guard Start Date는 민팅을 차단한다.

잠금 전 readback은 서비스 update authority와 임시 `ImmutableMetadata`를 요구한다. 잠금 후에는 Collection의 update authority가 lock PDA이며 `ImmutableMetadata`는 없고 정확한 Machine PDA delegate만 남아야 한다. Collection 불변성은 이 서명 불가능한 관리 권한으로 보장한다. `isMutable=false` 설정만으로 개별 Asset에 ImmutableMetadata 플러그인이 자동 생성된다고 가정하지 않는다. 실제 Asset의 update authority가 이 Collection을 가리키는지, 임의 delegate가 없는지, 소유자와 서비스 지갑의 metadata 수정이 거절되는지를 검증한다. SDK evidence는 `collectionMetadataProtection=LOCKED_AUTHORITY`, `immutableMetadata={present:false,authorityKind:null}`을 기록하고 실제 잠금 이후 이름·URI 변경 거절과 민팅 성공을 검증한다.
