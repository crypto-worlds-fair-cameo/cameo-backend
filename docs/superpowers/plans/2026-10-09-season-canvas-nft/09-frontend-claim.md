# 공통 수령 UI와 시즌·프로필 연결 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시즌 상세·캔버스·프로필에서 같은 NFT 수령 흐름을 제공한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 이 문서는 로컬 구현·검증 기록을 포함한다. 체크된 항목은 로컬 증거 기준이며 실제 Devnet 민팅 완료를 뜻하지 않는다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **01·07·08 API 계약 완료. 최종 통합은08 완료 필요**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 14절, 16절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

모든 경로는 frontend 저장소 기준이다.
생성: `src/features/season-nft-claim/index.ts`, `src/features/season-nft-claim/api/season-nft.types.ts`, `season-nft.api.ts`, `season-nft.queries.ts`.
생성: `src/features/season-nft-claim/model/useSeasonNftClaim.ts`, `claim-query-keys.ts`.
생성: `src/features/season-nft-claim/ui/SeasonNftClaimCard.tsx`, `SeasonNftClaimCard.test.tsx`.
생성: `src/shared/lib/solana-wallet/sign-transaction.ts`.
변경: `src/pages/season-canvas/ui/SeasonDetailDialog.tsx`, `SeasonWorkspacePanel.tsx`.
변경: `src/pages/profile/api/profile.api.ts`, `profile.queries.ts`, `src/pages/profile/ui/JoinedCanvases.tsx`, `MySeasons.tsx`, `src/pages/profile/ProfilePage.test.tsx`.
기존 참조: `src/app/layout/header/lib/wallet-standard.ts`, `src/shared/api/http-client.ts`, `src/entities/session/api/session.api.ts`.
백엔드 계획 디렉터리에서 프론트 파일을 만들지 않는다.

## 작업 09.1 — 사용자별 query와 wallet transaction adapter

**인터페이스와 인계:** 입력: authenticated userId, seasonId, activeWallet, 서버 network. 출력: status/attempt query와 명시적 sign action.

### 구현 순서

- [x] 1. 서로 다른 userId의 query key가 다르고 로그아웃 때 미전송 signed bytes가 버려지는 테스트를 만든다.

- [x] 2. 기존 http-client와 cookie 방식을 재사용해 원본 14절 endpoint를 연결한다. error envelope를 읽어 code를 UI 상태로 변환한다.

- [x] 3. 상태 polling30초, 활성 attempt3초, 오류 시15초까지 늘리고 hidden tab은 멈춘다. React Query의 visibility 설정을 기존 프로젝트 방식으로 적용한다.

- [x] 4. 선택 account의 address·chains·solana:signTransaction 지원을 확인한다. 원본 서버 network를 solana:devnet/solana:mainnet chain identifier로 매핑한다.

- [x] 5. 사용자 click handler에서만 wallet feature를 호출한다. signed bytes를 transactionId와 함께 backend에 제출하고 브라우저가 RPC로 전송하지 않는다.

- [x] 6. 응답 도중 사용자·계정·시즌이 바뀌면 이전 서명 결과 제출을 막는다. 비밀키를 요청하거나 저장하지 않는다.


### 고정할 계약·핵심 구현

```ts
export const claimQueryKeys = {
  status: (userId: string, seasonId: string) =>
    ['season-nft', userId, seasonId, 'status'] as const,
  attempt: (userId: string, network: 'devnet' | 'mainnet-beta', seasonId: string, attemptId: string) =>
    ['season-nft', userId, network, seasonId, 'attempt', attemptId] as const,
};
export function walletChain(network: 'devnet' | 'mainnet-beta') {
  return network === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
}
```

### 검증과 완료 판정

polling만으로 wallet sign spy0회. 계정 변경 중 반환된 signature는 submit0회. feature 미지원/주소 불일치/chain 미지원은 버튼 disabled와 이유 표시.

실행 위치: frontend.

```text
npm run test
```

기대 결과: 지갑 서명은 사용자 클릭으로만 실행하고 서버가 전송한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 09.2 — 상태별 카드와 세 진입점

**인터페이스와 인계:** 입력: SeasonNftView/ClaimAttemptView. 출력: SeasonNftClaimCard와 실제 profile 목록.

### 구현 순서

- [x] 1. 원본 16.2절 상태표 각 행을 component 테스트 fixture로 작성한다. CLAIMED/RESOLVING에는 재발행 버튼이 없어야 한다.

- [x] 2. 카드에 이미지·이름·수령 지갑·현재 단계·추정 비용·진행 문구를 표시한다. 비용은 bigint lamports를 정밀도 손실 없이 SOL 문자열로 변환한다.

- [x] 3. 첫 받기 click은 시도를 접수한다. AWAITING_SIGNATURE가 되면 해당 단계 비용을 보여주고 별도 승인 click으로 wallet을 연다. 다음 단계도 사용자 click을 받는다.

- [x] 4. 같은 카드를 상세 dialog/workspace/profile에 넣는다. 각 페이지가 서로 import하지 않도록 common feature에서 export한다.

- [x] 5. JoinedCanvases만 실제 /seasons/participated 데이터로 연결한다. MySeasons의 잘못된 NFT 발행 버튼·minted 표현은 제거하고 해당 기존 시즌 샘플은 샘플임을 명시한다. MySeasons 전체 실제 데이터 교체는 이번 범위가 아니다.

- [x] 6. 성공하면 NFT 상태·시즌 상세·profile 목록 query를 invalidate한다. receipt verified인 경우 network에 맞는 explorer 링크를 제공한다.

- [x] 7. 키보드 focus·dialog 접근·모바일·진행 상태 텍스트를 검증한다. 서명 취소는 claim 소진으로 표시하지 않는다.


### 고정할 계약·핵심 구현

```ts
export function lamportsToSol(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
// 예상 값: '1' -> '0.000000001', '1000000000' -> '1'.
// 수수료 값은 서버의 estimatedCostLamports만 사용한다.

```

### 검증과 완료 판정

수령 완료3화면 동기화. 새로고침 후 activeAttempt 재연결. 두 번째 지갑승인은 자동으로 열리지 않음. profile sample minted 값 사용0곳.

실행 위치: frontend.

```text
npm run test && npm run lint && npm run format:check && npm run build
```

기대 결과: 세 진입점에서 동일 상태와 같은 수령 권한을 표시한다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 프론트 테스트와 실제 wallet Devnet E2E를 구분한다. 지갑 mock만으로 실제 발행 완료라고 보고하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- `src/shared/i18n/locales/ko.json`과 `en.json`의 common 번역에 `seasonNft` 객체를 추가한다. `useTranslation('common', { keyPrefix: 'seasonNft' })`를 사용하고 별도 namespace를 만들지 않는다.
- 카드 props는 아래 최신 기준 재점검 절의 `SeasonNftClaimCardProps`다. userId와 activeWallet은 session query에서 읽는다.
- profile은 initialSummary를 사용하며 idle에는 별도 status query를 실행하지 않는다. 받기를 시작하거나 activeAttempt가 있으면 status/attempt query를 활성화한다.
- 목록은20개씩 더보기한다. NFT와 무관한 배지·성과·기타 profile 샘플 API는 교체하지 않는다.
- attempt query key는 userId/network/seasonId/attemptId를 포함한다. status는 userId/seasonId로 시작하고 network 변경 시 해당 사용자의 NFT cache를 제거한다.
- 버튼 문구는 구현 결정 계약9절을 따른다. WAITING_FOR_END/PREPARING/EMPTY/UNAVAILABLE/NOT_PARTICIPANT/NO_VALID_STROKE에는 서명 버튼이 없다.
- 지갑 취소에는 안내와 `다시 서명`을 표시한다. attempt를 FAILED로 변조하지 않는다. 반복 click 중 하나의 서명 Promise만 허용한다.
- 완료 링크는 CLAIMED/VERIFIED에만 제공한다. RESOLVING에는 `수령 완료 · 거래 정보 확인 중`을 표시하고 민팅 버튼을 숨긴다.
- 단계별 예상 SOL과 `예상 비용이며 실제 비용은 달라질 수 있습니다.`를 표시한다. 0을 무료 민팅 보장으로 설명하지 않는다.
- 세션 만료401에서는 미제출 signed bytes를 폐기하고 기존 로그인 UI로 안내한다. 이미 제출된 거래를 로그아웃으로 취소했다고 표시하지 않는다.
- mutation 자동 retry는0이다. 상태 GET은 최대2회 재시도 후 polling backoff로 전환한다. POST 재시도는 사용자 click 또는 응답 유실 후 상태 조회에 따른 명시적 재접수다.

컴포넌트 테스트에는 Enter/Space 조작, disabled일 때 sign 호출0, dialog를 닫았다 다시 열기, hidden tab 복귀를 포함한다. 다음 단계로 상태가 바뀌어도 자동 팝업은0회여야 한다. 실제 Wallet E2E는10에서 별도로 수행한다.

## 2026-10-10 최신 main 기준 보완

기준은 frontend `bd58aca`, backend `ca0554b`다. 아래 이미지·타입·번역 계약을 적용한다.

### 이미지와 히스토리 경계

- `/history`와 `pages/history/*`는 메인 캔버스의 시간별 snapshot 조회다. NFT 진입점은 시즌 상세·workspace·profile로 유지하고 history에 민팅 버튼이나 시즌 수령 API를 붙이지 않는다.
- `VITE_MAIN_CANVAS_ID`는 history 전용이며 NFT에 사용하지 않는다. 시즌 ID는 현재 화면 또는 참여 목록 응답에서 받는다.
- NFT의 확정 `imageUrl`은 `https://arweave.net/<dataItemId>`를 검증한 뒤 일반 `<img>`로 표시한다. runtime canvas의 `canvasSnapshot.ts` loader 또는 draw/continuation 복구 흐름에 넣지 않는다.
- `resources/nft-media`에서 최종 hash를 검증하는 backend 책임을 유지한다. 브라우저 이미지 표시는 추가 CORS fetch나 PNG 디코더 검증을 필수로 만들지 않는다.
- `api/season-nft.types.ts`의 응답 검증에서 영구 imageUrl/metadataUri는 HTTPS, hostname=arweave.net, credentials/port/query/hash 없음, path=/[A-Za-z0-9_-]{43}를 검사한다. null은 API 계약이 허용한 상태에만 허용한다.
- profile의 finalImageUrl은 backend snapshot 미리보기다. 별도 HTTP(S) 절대 URL 검증 후 표시하며 Arweave NFT 이미지와 같은 필드로 취급하지 않는다. NFT detail 응답의 imageUrl이 생기면 그 이미지로 전환한다.
- workspace의 기존 origin allowlist를 넓히거나 `VITE_CANVAS_SNAPSHOT_ORIGIN`을 NFT 때문에 Arweave로 바꾸지 않는다. 이번 기능에 이미지 다운로드 버튼을 추가하지 않는다.
- 이미지 로드 실패는 placeholder와 재시도 안내로 처리한다. backend READY와 사용자 수령 권한을 프론트 이미지 로드 실패로 바꾸지 않는다.

### 응답 타입과 import 경계

profile 목록의 nft는 전체 SeasonNftView가 아니라 summary다. 빠진 name/metadataUri/eligibleCount를 추정하거나 강제 type assertion으로 채우지 않는다.

```ts
export type SeasonNftSummary = Pick<
  SeasonNftView, 'network' | 'availability' | 'reason' | 'claim'
>;
export type SeasonNftClaimCardProps = {
  seasonId: string;
  source: 'detail' | 'workspace' | 'profile';
  initialSummary?: SeasonNftSummary;
  previewImageUrl?: string | null;
};
```

- profile은 item.nft를 initialSummary로, item.finalImageUrl을 previewImageUrl로 전달한다. 시즌 제목은 부모 목록 item에서 표시한다.
- profile idle에는 summary만 사용한다. 받기 click 시 detail GET으로 현재 지갑·READY·공통 정보를 확인한 다음 create POST를 보낸다. 숨은 지갑 팝업은 열지 않는다. activeAttemptId가 있으면 상태 조회를 즉시 재개한다.
- season detail/workspace는 자체 status query로 전체 응답을 얻는다. query 캐시와 summary를 하나의 완전한 서버 응답인 것처럼 합성하지 않는다.
- 페이지는 `@/features/season-nft-claim`의 index.ts 공개 export만 사용한다. feature는 pages/profile·pages/history·app/layout/header 내부를 import하지 않는다.
- wallet discovery와 transaction signing에 필요한 범용 동작만 shared/lib/solana-wallet에 둔다. 기존 header가 이를 사용하도록 조정하며 NFT feature에서 header를 역방향 import하지 않는다.
- 프론트 전송 타입은 feature의 api/season-nft.types.ts가 소유한다. backend 소스 파일을 프론트에서 import하지 않는다. profile의 lifecycle 값은 기존 네 가지 문자열을 유지하며 다른 page 내부 타입을 import하지 않는다.
- 번역은 기존 common namespace의 seasonNft 객체를 사용하므로 새 history namespace/resources/ns를 덮어쓰거나 제거하지 않는다.
- API는 기존 axiosInstance에서 prefix를 한 번만 적용하고 각 인증 요청에 withCredentials:true를 명시한다. `/api/api/...` 경로를 만들지 않는다.

추가 테스트: canonical Arweave URL은 NFT 카드에서 표시되고 workspace loader를 호출하지 않음, 잘못된 영구 URI 거절, profile summary만으로 idle 렌더 가능, 받기 전 detail GET, history route·namespace 보존, common 번역 ko/en 존재. 기존247개 테스트와 build가 최신 기준에서 통과했으며 NFT 구현 후 새로운 테스트를 더해 다시 검증한다.

## 프로필 최종 범위와 상태 표시

- 실제 참여 목록은 JoinedCanvases다. 개설자의 자동 참가도 이 목록에 포함되므로 만든 시즌의 NFT도 여기서 받는다. MySeasons 전체 API 교체를 위해 creator filter/participantCount 계약을 추가하지 않는다. 기존 샘플에는 샘플 표시를 유지·추가하고 NFT 버튼과 성공한 것처럼 보이는 minted 표현만 제거한다.
- `pages/profile/ui/ProfileContent.tsx`는 activeWallet.address를 표시한다. 첫 wallets 항목을 표시하는 기존 코드를 유지하지 않는다.
- `shared/ui/status-badge.tsx`의 허용 상태를 scheduled/active/ended/cancelled로 확장하고 현재 active/ended 표시를 보존한다. 기존 번역 위치에 ko/en의 예정/취소 문구를 추가한다. scheduled/cancelled를 ended로 강제 변환하지 않는다.
- 참여 목록 query 하나가 visible30초 polling, hidden pause, 복귀 refetch를 수행한다. idle 카드별 polling은 하지 않는다. PREPARING→READY가 목록 refetch로 카드에 반영되는 테스트를 포함한다.
- 상태 배지 네 가지, 실제 로그인 지갑, profile 목록 자동 갱신, MySeasons의 NFT placeholder 제거를 검증 범위에 추가한다.


## 구현 검증 기록 — 2026-10-10

로컬 판정: **LOCAL_ACCEPTED**. 구현 담당자, 독립 리뷰어, 주 담당자의 교차 점검을 완료했다. 미해결 중요·보통 지적은 없다.

- 프론트 전체 테스트: 52개 파일, 323개 테스트 통과. lint, format:check, production build, git diff --check 통과.
- 공통 카드·지갑 서명·응답 검증·비동기 결과 폐기·조회 오류 복구·참여 목록 페이지 처리를 구현했다. 제목 길이는 백엔드와 같은 Unicode code point 기준이다.
- 세 진입점 모두 실제 컴포넌트를 로컬 API fixture로 브라우저에서 확인했다. 프로필, 상세 dialog, workspace의 데스크톱·390×844 모바일 배치와 가로 넘침을 확인했다. 상세 dialog의 세로 스크롤·닫기 후 포커스 복원·Enter 재열기, workspace의 버튼 키보드 포커스를 확인했다.
- 임시 브라우저 fixture는 원본과 바이트 단위로 일치하게 복원했다. 서버를 종료했으며 제품 코드에 fixture를 남기지 않았다.
- 구현 보고서: `/private/tmp/season-nft-09-report.md`. 독립 리뷰: `/private/tmp/season-nft-09-review.md`. 임시 보고서의 핵심 결과는 이 절에 보존한다.
- 기존 큰 번들 경고와 개발 환경 next-themes 경고는 NFT 기능의 실패로 확인되지 않았으며 별도 관찰 사항이다.

### 외부 검증 — 미완료

- [ ] 실제 두 지갑의 Devnet proof/mint 서명과 발행: 10단계에서 실행한다. 로컬 mock 검증으로 대체하지 않는다.
- [ ] 실제 Mainnet 발행 인수: 11단계에서 별도 실행한다.
