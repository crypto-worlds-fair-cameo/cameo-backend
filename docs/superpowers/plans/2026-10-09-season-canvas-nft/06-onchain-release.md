# 시즌 발행 환경 생성·권한 잠금·자동 개방 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시즌별 발행 설정을 생성·검증·잠그고 자동으로 수령을 개방한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 **로컬 구현·교차 검토 완료, 외부 체인 검증 미완료** 상태다. 체크된 구현 항목은 로컬 테스트 범위이며 실제 발행 증거를 대신하지 않는다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **02~05 산출물 필요; 실제 체인 검증은 CHAIN_AUTHORITY PASS**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 12절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/season-nfts/resources/solana-nft/season-release-chain.ts`, `preparation-key-store.ts`.
변경: `features/prepare-season-nft/prepare-season-nft.use-case.ts`, `nft-transaction.repository.ts`.
생성 테스트: `test/season-nft/release-preparation.test.cjs`.
00 검증 스크립트의 SDK 호출과 권한 이관 순서를 production provider로 옮기며 검증 증거와 함께 비교한다.

## 작업 06.1 — 동일 계정으로 준비 재시도

**인터페이스와 인계:** 입력: FROZEN claims, VERIFIED PNG/JSON, root/count. 출력: Collection/Machine/Guard 주소와 준비 거래 이력.

### 구현 순서

- [x] 1. 계정 생성 직후 crash와 transaction 만료 후 재시도를 테스트한다. 같은 공개 주소·keypair 파일이 사용되어야 한다.

- [x] 2. keypair 생성 시 0700 directory와0600 file에 atomic write한다. DB에는 주소와 preparation_keys 파일 ID만 기록한다.

- [x] 3. 이미 계정이 체인에 있으면 owner/program/config를 검증한다. 존재한다는 이유만으로 재사용하지 않는다.

- [x] 4. 00에서 검증한 SDK로 collection immutable metadata, hidden name/URI, itemsAvailable, allowlist/root, mintLimit1을 설정한다.

- [x] 5. 각 서비스 거래를 PREPARED→SIGNED DB commit 뒤 05 dispatcher로 전송한다. RPC 호출을 별도 직접 경로로 만들지 않는다.


### 고정할 계약·핵심 구현

```ts
export type ReleaseChainConfig = {
  releaseId: string;
  network: 'devnet' | 'mainnet-beta';
  name: string; metadataUri: string; eligibleCount: number;
  merkleRoot: Uint8Array;
};
// SeasonReleaseChain.prepare(config: ReleaseChainConfig): Promise<'PENDING' | 'PREPARED'>
// PREPARED는 모든 준비 계정의 finalized 확인과 설정 일치를 뜻한다.

```

### 검증과 완료 판정

process restart 후 새 Collection 생성0회. 동일 주소에 다른 owner/config면 BLOCKED. 잔액 부족은 자격 유지·재시도 대기. secret file이 public static 루트에 있으면 거절.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 중간 실패가 시즌별 중복 컬렉션 생성으로 이어지지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 06.2 — 최종 잠금과 READY

**인터페이스와 인계:** 입력: 검증된 준비 계정과 00 권한 잠금 증거. 출력: LOCKED/READY 또는 BLOCKED.

### 구현 순서

- [x] 1. 이름·URI·root·수량·delegate 중 하나가 틀리면 잠금/READY가 거절되는 테스트를 만든다.

- [x] 2. 잠금 전 Start Date 차단을 유지한다. 최종 설정과 권한 잠금을 00에서 검증한 원자적 순서로 처리한다.

- [x] 3. 관리 authority를 off-curve PDA로 이관하되 machine mint authority는 guard로 유지하고 collection mint delegate도 유지한다.

- [x] 4. 모든 잠금 결과를 finalized 조회로 검사한다. 실패 시 운영자 키를 남겨놓고 READY 처리하지 않는다.

- [x] 5. chain lock 성공 후 DB 반영 전 crash에서는 재조회로 locked_at/ready_at과 READY를 기록한다. READY 이후 명단/URI/root를 수정하는 경로를 차단한다.

- [x] 6. 지속 key 파일 정리는 READY 확인 이후만 허용한다. 미수령 자산을 위한 collection/machine rent 회수 기능은 추가하지 않는다.


### 고정할 계약·핵심 구현

```ts
export type LockVerification = {
  finalized: boolean;
  metadataMatches: boolean;
  rootMatches: boolean;
  supplyMatches: boolean;
  managementLocked: boolean;
  mintDelegatePreserved: boolean;
};
export function canOpenClaims(v: LockVerification): boolean {
  return v.finalized && v.metadataMatches && v.rootMatches && v.supplyMatches
    && v.managementLocked && v.mintDelegatePreserved;
}
```

### 검증과 완료 판정

각 boolean을 하나씩 false로 바꾸면 canOpenClaims=false. chain 성공/DB 실패 뒤 재실행에서 잠금 거래를 새로 만들지 않고 READY 복구.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 정상 종료 시즌은 운영자 승인 없이 자동 수령 개방된다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 잠금 이후 허용 지갑의 실제 민팅 가능성이 00 증거로 확인돼야 완료다. unit test만으로 온체인 권한 검증을 대신하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- 00의 SDK evidence에서 CHAIN_AUTHORITY가PASS가 아니면 실제 release 생성·잠금 검증을 완료 처리하지 않는다. STORAGE_RECOVERY 미실행만으로 chain provider의 독립 구현을 중단하지 않는다. pure validation·fake chain tests는 작성 가능하다.
- 준비 순서: immutable Collection 생성→Machine 및 민팅 delegate→Guard allowlist/mintLimit/Start Date 차단→설정 재조회→Collection/Machine 관리 권한 잠금→마지막 거래에서 Start Date 제거와Guard 관리 권한 잠금→finalized readback→READY다.
- Start Date는 잠금 해제 계획까지 외부 민팅이 불가능하도록 00에서 지원범위를 검증한 미래값을 사용한다. 최대 supported timestamp를 SDK source에서 확인하고 evidence에 정확한 정수로 저장한다. 날짜 상한을 추정하지 않는다.
- Collection에도 해당 시즌 name/metadata URI를 사용한다. Royalties plugin과 추가 자산 지불 guard는 생성하지 않는다.
- guard groups는빈 배열이다. hidden settings가 원본 name/URI를 치환하지 않아야 하고 `itemsAvailable=eligible_count`다. Root는 frozen merkle_root와 byte일치해야 한다.
- lock PDA는 System Program ID와 seed `cameo-nft-lock-v1`로 SDK의 canonical PDA derivation을 사용한다. bump와 결과 address를00 evidence에 저장한다.
- 준비 key files는 `<keyDir>/<network>/<releaseId>/<collection|machine|guard>.json`이다. SDK가 keypair를 필요로 하지 않는 PDA 계정은 keyfile을 만들지 않는다. 잘못된 파일이나 expected pubkey 불일치는 BLOCKED다.
- 프로그램이 이미 같은 주소에 계정을 만들었으면 address/program owner/settings/delegate를 검증해 RECONCILED로 이어간다. 설정이 다르면 update로 덮어씌워 정상화하지 않는다.
- READY 전 소량 실제 민팅으로 검증하는 로직을 production release에 넣지 않는다. 총공급을 소비하는 실험은00 전용 fixture에서만 수행한다.
- 자동 준비 실패는 사용자에게PREPARING이고 운영자에게BLOCKED 원인을 기록한다. 서비스 잔액 부족은5분 뒤 재시도하며 기존 frozen 명단·주소를 유지한다.

필수 readback 필드: Collection name/URI/임시 ImmutableMetadata 제거/update authority/delegate, Machine name/URI/itemsAvailable/mint authority/management authority, Guard root/mintLimit id0 limit1/빈groups/Start Date제거/management authority. 하나라도 다르면 canOpenClaims=false다.


- v1은 단일 backend replica와 동일 지속 볼륨 재연결을 지원한다. key 파일은 no-clobber atomic publish하며 기존 파일이 있으면 주소를 검증해 채택한다. 다른 호스트의 별도 로컬 디렉터리로 자동 failover하지 않는다.

## 구현 검증 기록 — 2026-10-10

- 로컬 구현과 독립 리뷰를 통과했다. 실제 RPC transport, SDK builder/decoder, 지속 키 저장, 준비 거래 저장, 단계 전이, 최종 권한 검증을 연결했다.
- 주요 구현: `resources/solana-nft/season-release-chain.ts`, `preparation-key-store.ts`, transaction dispatcher/repository, release repository, runtime queue, worker startup validator, module 등록. 경로는 `src/modules/season-nfts/` 기준이다.
- 모든 실제 RPC 요청은 공유 scheduler를 통과한다. account effect 조회는 최대 33개 거래 단위로 나누어 요청마다 제한을 적용한다. enabled startup은 genesis hash를 확인한 뒤 DB leadership을 시작한다.
- 예상하지 않은 Collection plugin·external adapter·Guard 조건은 변경 전에 거부한다. 서비스 Guard 권한은 정확한 미래 Start Date를 요구하고, 잠긴 Guard 권한은 Start Date 제거를 요구한다. 불일치 시 준비 거래와 단계 변경은 0회다.
- DB에는 두 준비 키의 정확한 주소/상대 경로를 보존한다. identity 저장 후 버전이 바뀌어도 영구 오류를 BLOCKED로 기록한다. 최종 잠금 후 정상 민팅이 발생한 경우에도 READY 복구를 허용한다.
- 검증: focused 17/17, Docker PostgreSQL 기반 NFT 162/162, realtime/canvas 63/63, typecheck·lint·format·diff 검사 통과. 마지막 Guard 조건 변경 뒤 focused/NFT/정적 검사를 다시 통과했으며 기존 realtime 결과는 영향 없는 범위로 유지했다.
- 독립 리뷰의 5개 지적과 Guard authority/Start Date 추가 사례를 수정하고 재검토했다. 원래 구현자와 리뷰어의 보고서를 root가 교차 확인했다.
- 후속08의 claim builder·receipt provider는 아직 미구현이다. 실제 민팅 성공으로 대체하거나 가장하지 않는다.

### 외부 완료 조건

- [ ] CHAIN_AUTHORITY: 실제 Devnet에서 계정 생성·권한 잠금·잠금 후 허용 지갑 민팅을 검증한다.
- [ ] STORAGE_RECOVERY: 실제 배포의 지속 볼륨 재연결 후 동일 키·주소 복구를 검증한다.
- [ ] 배포 RPC endpoint의 실제 genesis 일치를 10단계 preflight에서 확인한다.

위 외부 검증은 NOT_RUN이며 06단계 전체 발행 검증 완료를 의미하지 않는다. commit·push·배포·유료 외부 호출은 수행하지 않았다.

### Core Candy Machine의 필수 Collection delegate

- Machine 생성 전에는 Collection에 `ImmutableMetadata`만 존재한다. Machine 생성 후에는 SDK가 설치한 `UpdateDelegate`도 반드시 존재해야 한다.
- `UpdateDelegate.authority.type`은 `UpdateAuthority`, `additionalDelegates`는 해당 Machine 주소로 `findCandyMachineAuthorityPda`를 호출해 계산한 PDA 하나와 정확히 같아야 한다. 누락, 다른 주소, 추가 주소, 다른 delegate plugin은 거절한다.
- Collection 관리 권한을 lock PDA로 이전해도 이 발행 delegate는 유지한다. Collection의 delegate가 비어 있어야 한다는 검증은 적용하지 않는다. 민팅된 개별 Asset에 delegate가 없어야 한다는 기존 조건은 유지한다.
- finalized readback과 setup 거래 복구에 동일한 조건을 적용한다. SDK evidence에는 `collectionMintDelegate`의 expected PDA, actual 주소 배열, authorityKind를 기록한다.

### Collection 메타데이터 잠금의 실행 조건

`ImmutableMetadata`는 Collection의 이름·URI뿐 아니라 update authority 변경도 거절한다. 따라서 `setup:lock:1`은 `removeCollectionPlugin(ImmutableMetadata)`와 `updateCollectionV1(newUpdateAuthority=lock PDA, newName=None, newUri=None)`를 **하나의 Solana 거래**로 실행한다. 둘 중 하나라도 실패하면 모두 롤백된다. 이 시점까지 Guard Start Date는 민팅을 차단한다.

잠금 전 readback은 서비스 update authority와 임시 `ImmutableMetadata`를 요구한다. 잠금 후에는 Collection의 update authority가 lock PDA이며 `ImmutableMetadata`는 없고 정확한 Machine PDA delegate만 남아야 한다. Collection 불변성은 이 서명 불가능한 관리 권한으로 보장한다. `isMutable=false` 설정만으로 개별 Asset에 ImmutableMetadata 플러그인이 자동 생성된다고 가정하지 않는다. 실제 Asset의 update authority가 이 Collection을 가리키는지, 임의 delegate가 없는지, 소유자와 서비스 지갑의 metadata 수정이 거절되는지를 검증한다. SDK evidence는 `collectionMetadataProtection=LOCKED_AUTHORITY`, `immutableMetadata={present:false,authorityKind:null}`을 기록하고 실제 잠금 이후 이름·URI 변경 거절과 민팅 성공을 검증한다.
