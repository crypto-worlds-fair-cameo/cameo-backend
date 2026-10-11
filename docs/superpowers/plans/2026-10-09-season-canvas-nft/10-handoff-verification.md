# 운영 도구·배포 인계·Devnet 통합 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 동료가 배포하고 검증할 수 있는 운영 명령·문서·Devnet 증거를 준비한다.

**Architecture:** 원본의 feature-first module 경계를 유지한다. DB 상태를 기준으로 재시작을 복구하며 외부 전송과 DB 트랜잭션을 분리한다.

**Tech Stack:** TypeScript, NestJS, PostgreSQL, React/React Query, Wallet Standard. 외부 체인·저장 SDK 버전은 00 검증 산출물을 따른다.

## Global Constraints

- 로컬 구현·검증은 완료했으며 외부 실행 검증은 미완료다. 체크박스는 각각의 실제 증거 기준으로 판정한다.
- backend 기준 Node `>=24.21.0 <25`, 기존 NestJS/pg/TransactionRunner 패턴을 따른다.
- 정상 종료한 신규 시즌만 대상으로 한다. 유효 usage ≥1, 고정 참가 지갑, 사용자·시즌별 성공 mint 최대1회, 정원2..100이다.
- 수령 기한 없음, 실제 체인 비용만 사용자 부담, 별도 mint 가격·로열티 없음. 서비스가 공통 준비·저장 비용을 낸다.
- 원본의 REQ-001~024 및 INV-01~10을 변경하지 않는다. 해당 작업에서 언급하지 않은 정책도 적용된다.
- 코드 수정 시 comment-code-intent 적용. API 계약은 Swagger/응답 모델, 오류 message는 영어다.
- 원본 정책과 실행 계획이 충돌하면 임의 구현하지 않고 충돌을 해결한 뒤 관련 문서를 함께 수정한다.
- 외부 SDK 호출은 00에서 확인한 실제 export와 권한 동작을 사용한다. 아래 TypeScript/SQL 코드는 고정할 계약·핵심 로직이며 SDK 검증을 대신하지 않는다.
- 기존 파일은 수정 전에 현재 내용을 읽는다. 신규 경로는 이 계획의 예정 경로다. 파일 이동이 확인되면 동일 책임 파일로 매핑하고 인계 기록에 남긴다.

## 시작 조건과 읽을 문서

- 선행 작업: **01~09 완료. 00 Devnet 증거 필수**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 7절, 15절, 17절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

생성: `scripts/season-nft/preflight.cjs`, `scripts/season-nft/retry-release.cjs`, `docs/deployment/season-canvas-nft.md`, `docs/deployment/season-nft-acceptance.md`.
변경: `package.json`, `.env.example`, 실제 API 흐름 문서.
생성 테스트: `test/season-nft/operator-tools.test.cjs`, `test/season-nft/end-to-end.test.cjs`.
01의 reset-development-seasons.cjs를 인계 절차에 포함한다. 클라우드 IaC·CI·배포 자동화는 이 기능의 필수 산출물이 아니다.

## 작업 10.1 — preflight·고정 자료 재시도·설정 문서

**인터페이스와 인계:** 입력: 배포 환경의 DB/RPC/지갑/지속 저장소. 출력: 안전하게 마스킹한 사전 검사 결과 및 단계별 runbook.

### 구현 순서

- [x] 1. preflight가 설정 없음·network 불일치·키 파일 권한 오류·snapshot disabled·비지속 경로를 진단하는 테스트를 작성한다.

- [x] 2. 사전 검사는 읽기만 수행한다. 잔액 부족은 필요한 항목과 현재 잔액만 표시하고 자동 결제·자동 충전을 하지 않는다.

- [x] 3. retry CLI는 UUID releaseId를 받아 BLOCKED 원인을 재검사하고 next_attempt_at을 갱신한다. root/name/URI/claims 수정 인자를 제공하지 않는다.

- [x] 4. package scripts에 아래 명령을 연결하고 실제 CLI --help와 문서가 일치하는지 검사한다.

- [x] 5. runbook에 동료의 서비스 지갑 생성·별도 network 키 관리·RPC 발급·Turbo 자금·secret mount·지속 경로·DB migration·snapshot worker·NFT enabled 순서를 작성한다.

- [x] 6. 키는 GitHub/frontend/log에 넣지 않는다. 사용자 GitHub 업로드와 동료 배포라는 역할을 명시한다.


### 고정할 계약·핵심 구현

```json
{
  "nft:preflight": "node scripts/season-nft/preflight.cjs",
  "nft:retry-release": "node scripts/season-nft/retry-release.cjs",
  "nft:reset-development": "node scripts/season-nft/reset-development-seasons.cjs"
}
```

### 검증과 완료 판정

preflight는 DB INSERT·체인 send·업로드 호출0. retry CLI로 READY/EMPTY를 변경할 수 없음. 비밀값이 stdout/stderr에 없음.

실행 위치: backend.

```text
npm run test:nft
```

기대 결과: 동료가 동일 명령으로 설정 오류를 진단할 수 있다.

- [x] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [x] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 10.2 — 실제 두 사용자 Devnet E2E와 인계 기록

**인터페이스와 인계:** 입력: 통합 앱·Devnet 설정·실제 지갑2개. 출력: 실행 결과/미실행 구분된 acceptance 문서.

### 구현 순서

- [x] 1. backend typecheck/lint/format/test:nft/test:realtime 및 frontend test/lint/format/build를 실행한다. 실패는 관련 범위에서 수정 후 다시 실행한다.

- [ ] 2. 실제 시즌을 만들고 두 사용자가 유효 획을 남긴다. 정상 종료 후 final PNG hash·eligibleCount·공통 metadata를 확인한다.

- [ ] 3. 두 지갑으로 proof/mint를 실제 서명한다. 사용자 비용과 서비스 준비 비용이 분리되는지 확인한다.

- [ ] 4. 전송 후 서버 재시작과 브라우저 새로고침, 중복 클릭, 비참여 지갑, 유효 획 없는 참가자, 수령 후 전송을 검사한다.

- [ ] 5. 같은 metadata·권한 불변·MintCounter 중복 차단을 실제 결과로 확인한다. 소각 검증은 전용 테스트 자산만 사용한다.

- [ ] 6. 검증 문서에는 commit ID, network, 프로그램/SDK 버전, season/asset/transaction ID, 실행 명령, 성공/실패/미실행 사유를 기록한다. Mainnet 항목은 별도로 남긴다.


### 고정할 계약·핵심 구현

```markdown
| 검증 | 결과(PASS/FAIL/NOT_RUN) | 실행 명령/거래 | 근거 |
| 두 사용자 실제 민팅 | NOT_RUN | 실행 후 기록 | 미실행을 PASS로 바꾸지 않음 |
| 중복 및 외부 지갑 차단 | NOT_RUN | 실행 후 기록 | program error 확인 |
| 재시작 후 복구 | NOT_RUN | 실행 후 기록 | 같은 signature/asset |
| 메타데이터 불변 | NOT_RUN | 실행 후 기록 | 변경 거래 거절 |
| Mainnet 실제 인수 | NOT_RUN | 11 문서에서 수행 | Devnet과 분리 |

```

### 검증과 완료 판정

각 행의 PASS는 실제 증거를 갖는다. 지갑·자금이 없으면 NOT_RUN 상태로 동료가 실행할 절차와 함께 인계하며 기능 검증 완료라고 부르지 않는다.

실행 위치: backend.

```text
npm run typecheck && npm run lint && npm run format:check && npm run test:nft && npm run test:realtime
```

기대 결과: 로컬 자동 검사와 외부 통합 검증을 구분한 인계 자료가 완성된다.

- [ ] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [ ] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 개발 인계 완료와 Mainnet 실제 발행 완료는 별개다. 이 문서를 완료해도 11이 자동 완료되지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- 스크립트 인자·exit code·JSON 출력은 구현 결정 계약10절을 따른다. preflight는 지갑 생성·충전·업로드·DB 쓰기·chain send를 하지 않는다.
- check ID는 CONFIG, DB_SCHEMA, NETWORK_IDENTITY, SERVICE_WALLET, SERVICE_BALANCE, SNAPSHOT_SETTINGS, STORAGE_ENDPOINTS, PRIVATE_PATHS, PERSISTENCE_EVIDENCE, SDK_EVIDENCE다.
- URI와 키 파일 형식은 검사하되 실제 key 내용과 RPC query key를 출력하지 않는다. 서비스 잔액은 검증된 setup quote와 비교하며 임의의 고정 SOL 금액으로 충분하다고 판정하지 않는다.
- PERSISTENCE_EVIDENCE는 재배포 후 같은 파일의 hash가 유지된 증거가 없으면 PENDING이다. directory 존재만으로 영구 저장 PASS를 주지 않는다.
- runbook 순서는 서비스 중지, 초기 전환 reset 필요 여부 확인, migration, 환경·키·영구 저장 준비, preflight, snapshot worker, NFT 활성화, Devnet 검증, Mainnet 별도 인수다.
- BLOCKED retry는 유료 operation을 새로 만드는 명령이 아니다. 같은 root/URI/address를 유지하며 다음 검사 시각만 현재로 설정한다. frozen 자료 수정 flag는 없다.
- 앞선 작업에서 추가한 package script는 재사용한다. 기존 script를 다른 의미로 조용히 덮어쓰지 않는다.
- Devnet E2E는 실제 앱에서 정상 종료한 시즌으로1회 수행한다. 빠른 단위 테스트는 fake clock을 사용할 수 있다. 운영 최소1시간 규칙을 낮추지 않는다.
- 결과는 LOCAL_VERIFIED, EXTERNAL_VERIFIED, EXTERNAL_VALIDATION_PENDING, BLOCKED_TECHNICAL로 구분한다. 키가 없어도 빌드·로컬 테스트·문서는 작성할 수 있지만 외부 검증은 완료가 아니다.
- 인수 자료에 backend/frontend commit을 모두 기록한다. 동료 환경을 임의로 특정 클라우드로 가정하지 않는다.

- 운영 CLI는 빌드를 호출하지 않는다. 배포 준비 단계의 npm run build 산출물을 사용하고 dist가 없으면exit2로 안내한다. JSON 수집 예시는 `npm run --silent nft:preflight -- --evidence /absolute/path/persistence-evidence.json --json`이다.
- persistence evidence 입력 형식은 구현 결정 계약14절이다. 동료가 비민감 파일을 각 지속 경로에 두고 실제 재배포 전후 hash를 비교해 작성한다. 자동 검사가 그 수동 시험을 대신한 것으로 표시하지 않는다.


## 로컬 구현 검증 기록 — 2026-10-10

판정: **LOCAL_ACCEPTED / EXTERNAL_VALIDATION_PENDING**. 주 담당자와 독립 리뷰어가 구현·스펙·품질을 교차 검토했다. 10.1 운영 도구와 문서, 10.2의 로컬 자동 검증은 승인했으며 실제 두 사용자 Devnet 인수는 완료하지 않았다.

- 운영 도구·실제 내부 처리 통합 테스트 18/18, 전체 NFT 202/202, 실시간 회귀 63/63 통과. build, typecheck, lint, format:check, CLI 구문·help 및 diff 검사 통과.
- 프론트 09단계 승인 증거: 전체 323개 테스트와 정적 검사, 세 진입점의 데스크톱·모바일 브라우저 검증 통과. 10단계는 프론트 코드를 변경하지 않았다.
- 사전 점검 명령 전체를 임시 DB·로컬 RPC·임시 키·증거로 실행해 10개 검사와 exit0/1/3, RPC 읽기 호출 제한, DB 행 수 무변경을 확인했다.
- 비용은 실제 런타임 거래 5개와 계정별 임대료·수수료로 산출한다. 컬렉션 simulation이 불가하면 확인된 최소 필요액보다 잔액이 적을 때 실패하며, 정확한 총액을 확정할 수 없으면 대기한다.
- 두 사용자 통합 테스트는 실제 수령 usecase·거래 생성·서명 검증·dispatcher·reconciliation·receipt 검증 및 전송 중 재시작 복구를 실행했다. release 준비는 이미 확정된 체인 응답을 제공해 실제 검증 로직을 통과시켰으며, 준비 거래 5개의 실제 전송을 주장하지 않는다.
- 이 테스트에서 발견한 사용자 거래의 NullSigner 오류는 명시적인 noop 지갑 identity로 수정했다. 실제 사용자 서명과 자산 부분 서명 검증을 통과했다.
- 인계 문서: [운영 절차](../../../deployment/season-canvas-nft.md), [인수 기록](../../../deployment/season-nft-acceptance.md). 구현 보고서와 독립 리뷰는 `/private/tmp/season-nft-10-report.md`, `/private/tmp/season-nft-10-review.md`에 있으며 핵심 결과는 이 절에 보존한다.

### 외부 실행 — 미완료

- [ ] 실제 CHAIN_AUTHORITY 및 STORAGE_RECOVERY 검증.
- [ ] 동료 배포 환경의 지속 저장소 재배포 증거와 실제 preflight.
- [ ] 두 지갑의 실제 Devnet UI 수령·비용·재시작·중복·권한 불변 검증.
- [ ] 11단계 실제 Mainnet 인수. 로컬 승인으로 대체하지 않는다.
