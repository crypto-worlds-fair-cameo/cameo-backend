# 공통 메타데이터 생성과 영구 파일 게시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공통 메타데이터와 원본 PNG를 같은 바이트로 영구 게시하고 복구한다.

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

- 선행 작업: **02·03 완료. 실제 Turbo 게시 연결은 00 검증 필요**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 11절, 12절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `src/modules/season-nfts/resources/nft-media/season-nft-metadata.ts`, `turbo-media-publisher.ts`.
변경: `nft-upload.repository.ts`, `prepare-season-nft.use-case.ts`.
생성 테스트: `test/season-nft/metadata.test.cjs`, `test/season-nft/media-recovery.test.cjs`.
생성 설정은 원본 17절의 NFT_STORAGE_*와 NFT_UPLOAD_WORK_DIR만 사용한다.

## 작업 04.1 — 동일 바이트의 JSON과 UTF-8 이름

**인터페이스와 인계:** 입력: frozen title/description/seasonId/endedAt/count/image hash/URI. 출력: `buildAssetName(title: string): string`, `serializeSeasonMetadata(input: SeasonMetadataInput): Uint8Array`.

### 구현 순서

- [x] 1. 한글·emoji·$ID$ 포함 제목으로 byte 길이와 JSON 동일성을 검사하는 테스트를 먼저 작성한다.

- [x] 2. 아래 코드로 이름 byte 제한을 적용한다. 전체 제목은 Season Title attribute에 보존한다.

- [x] 3. SeasonMetadataInput의 필드를 seasonId,title,description(string|null),endedAt(UTC ISO string),contributors(number),imageUri,imageSha256로 정의한다.

- [x] 4. JSON 필드와 순서는 name,description,image,attributes,properties로 고정한다. attributes 순서는 원본 12.3절 순서다. JSON.stringify 결과의 UTF-8 bytes를 사용한다.

- [x] 5. 개인 주소·닉네임·로열티·일련번호를 넣지 않는다. 재실행 시 bytes/hash가 동일한지 검사한다.


### 고정할 계약·핵심 구현

```ts
export function buildAssetName(title: string): string {
  let name = 'Cameo ';
  for (const char of title.replaceAll('$', '＄')) {
    if (Buffer.byteLength(name + char, 'utf8') > 32) break;
    name += char;
  }
  return name;
}
```

### 검증과 완료 판정

assert(Buffer.byteLength(buildAssetName("가".repeat(50))) <= 32); assert(!buildAssetName("$ID$").includes("$")); 같은 input 두 serialize 결과는 deepEqual이며 UTF-8 replacement character가 없어야 한다.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 이름 제한과 동일 메타데이터 정책을 외부 서비스 없이 검증한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 04.2 — 게시 전 저장과 응답 유실 복구

**인터페이스와 인계:** 입력: releaseId, IMAGE/METADATA bytes와 SHA-256. 출력: hash 검증된 공개 URI와 VERIFIED upload row.

### 구현 순서

- [x] 1. fake uploader가 업로드 성공 후 timeout을 던지는 테스트를 만든다. 두 번째 실행에서 새 signed item을 생성하지 않는지 검사한다.

- [x] 2. 00에서 확인한 Turbo API로 signed data item을 만들고 임시 파일+fsync+no-clobber atomic publish로 지속 디렉터리에 저장한다. 파일 저장 완료 뒤 DB에 item ID/path/hash를 기록한다.

- [x] 3. 같은 release/kind row가 있으면 저장한 item bytes를 재사용한다. 파일 저장 후 DB 기록 전 crash로 남은 최종 파일은 signer·ID·payload·tags를 검증해 같은 item으로 채택한 뒤 DB에 기록한다. 검증되지 않은 파일은 업로드하지 않는다. 최종 파일을 덮어쓰거나 새 item으로 대체하지 않으며, 정리 대상은 DB에서 참조하지 않는 임시 파일로 한정한다.

- [x] 4. 업로드 receipt를 저장한 뒤 공개 URI를 읽어 hash를 확인한다. gateway 지연은 재조회하고 hash mismatch는 BLOCKED로 전환한다.

- [x] 5. IMAGE가 VERIFIED된 뒤 그 URI로 JSON을 만들고 METADATA를 게시한다. metadata VERIFIED 이후에만 온체인 준비를 허용한다.

- [ ] 6. 실제 메인넷 발행용 파일은 sandbox URI가 아닌 영구 게시임을 사전 검사와 증거에 기록한다.


### 고정할 계약·핵심 구현

```ts
export type MediaKind = 'IMAGE' | 'METADATA';
export type PublishMediaInput = {
  releaseId: string; kind: MediaKind; bytes: Uint8Array; sha256: string;
};
export type PublishedMedia = { uri: string; sha256: string; dataItemId: string };
// TurboMediaPublisher.publish(input: PublishMediaInput): Promise<PublishedMedia>
// 외부 전송은 이 순서를 유지한다:
// signed item 파일 저장 → upload row commit → 같은 bytes 전송 → 공개 URI hash 확인

```

### 검증과 완료 판정

timeout 후 재호출에서 dataItemId 동일·sign 호출1회. 파일 미존재면 새 항목 재생성으로 숨기지 않고 BLOCKED. URI content mismatch면 release READY 전환 불가.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 재시작과 gateway 지연에도 이미지·JSON이 달라지지 않는다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 이미지·JSON URI/hash가 고정되고 원본 PNG bytes를 그대로 사용한다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- `SeasonMetadataInput` 필드는 seasonId,title,description(string|null),endedAt(UTC ISO string),contributors(number),imageUri,imageSha256로 고정한다. name은 buildAssetName(title)에서만 생성한다.
- description은 null 또는 빈 문자열이면 기본 영어 문장이다. 원래 사용자 설명의 의미를 trim/번역해 다시 쓰지 않는다.
- JSON 객체의 정확한 형태는 다음과 같다. 파일 끝 개행·pretty print를 추가하지 않는다.

```ts
const metadata = {
  name: buildAssetName(input.title),
  description: input.description || 'A collaborative canvas completed on Cameo.',
  image: input.imageUri,
  attributes: [
    {trait_type: 'Season ID', value: input.seasonId},
    {trait_type: 'Season Title', value: input.title},
    {trait_type: 'Ended At', value: input.endedAt},
    {trait_type: 'Contributors', value: input.contributors},
    {trait_type: 'Image SHA256', value: input.imageSha256},
  ],
  properties: {files: [{uri: input.imageUri, type: 'image/png'}], category: 'image'},
};
const bytes = Buffer.from(JSON.stringify(metadata), 'utf8');
```

- 한글/emoji는 code point 경계로 자른다. `$` 치환은 name에만 적용한다. 전체 Season Title attribute는 원문을 유지한다.
- publish(input)는 즉시 업로드 성공을 약속하지 않는다. durable item이 먼저 있어야 하며 네트워크 timeout은 같은 row의 retry다. item 경로가 없는데 DB PREPARED가 있으면 새 item을 만들지 않고 BLOCKED다.
- 업로드 전 sha256(bytes)와 입력sha256을 비교한다. bytes mismatch는 전송0회다. 작업 디렉터리에 잘못된 signed item이 있으면 signer/data item ID까지 검증한다.
- IMAGE verified 뒤에만 JSON을 만든다. URI는 canonical Arweave URL이다. gateway env 변경은 fetch 위치만 바꿀 수 있고 frozen URI를 다시 쓰지 않는다.
- VERIFIED row는 재업로드하지 않는다. 프로세스 재시작 후 해당 단계의 다음 작업으로 진행한다.
- fixture gateway가200과 다른 bytes를 반환하면 BLOCKED/NFT_MEDIA_HASH_MISMATCH,404·timeout이면 due retry다. 최종 URI가 같은 ID여도 Content-Type이 image/png 또는 application/json이 아니면 내용 검증과 함께 진단하고 잘못된 파일을 READY로 열지 않는다.


- 파일 publish와 DB 기록 사이 crash에서는 기존 signed item을 검증해 채택한다. 최종 파일 덮어쓰기와 새 item 생성은 금지한다. 저장소 lane은 chain send lane과 분리한다. 순수 JSON·fake uploader 검증에는 외부 storage 계정이 필요하지 않다.

## 구현 검증 기록 — 2026-10-10

04의 로컬 구현·교차 검토를 완료했다. 실제 영구 저장소 게시 검증은 미완료다. `buildAssetName`·`serializeSeasonMetadata`, 실제 Turbo 서명 어댑터, ANS-104 전체 검증, private durable file 저장과 orphan 채택, receipt/public bytes 검증, 한 번에 한 checkpoint를 진행하는 `PrepareSeasonNftUseCase.prepareMedia`를 연결했다.

- `npm run test:nft` 108/108, `npm run test:realtime` 63/63 통과. typecheck, lint, format:check, git diff --check 통과.
- 직접 의존성 `@dha-team/arbundles@1.0.4`를 고정했고 Turbo2.1.0의 동일 버전과 dedupe됨을 확인했다. 기존00 SDK 버전은 변경하지 않았다.
- Root와 독립 리뷰어가 파일/DB 순서, 기존 서명 파일 재사용, EMPTY/disabled 외부 호출0, frozen snapshot identity, bounded reads를 대조했다. 압축 응답의 Content-Length 오판을 로컬 HTTP로 재현하고 수정·회귀 테스트를 확인했다. 열린 Critical/Important 지적0건.
- 구현 보고서 `/private/tmp/season-nft-04-report.md`, 독립 리뷰 `/private/tmp/season-nft-04-review.md`, 검토 snapshot `/private/tmp/season-nft-04-review.diff`. 임시 검토 파일은 필수 실행 문서가 아니다.
- 05는 `prepareMedia(releaseId)`를 별도 storage lane에서 실행한다. IMAGE 또는 METADATA 하나씩 진행하며, 이미 확정한 snapshot/head/hash/size와 signed item을 교체하지 않는다.
- 실제 Turbo 게시·응답 유실 복구·gateway 공개 조회와 배포 볼륨 지속성은 검증하지 않았다. STORAGE_RECOVERY와 CHAIN_AUTHORITY는 NOT_RUN이다. 04.2의 실제 게시 증거 항목은 미완료로 남겼으며 로컬 PASS가 외부 게이트를 대신하지 않는다.
