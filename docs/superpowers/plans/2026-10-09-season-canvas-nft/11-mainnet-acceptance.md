# 동료 배포 후 실제 Mainnet 발행 인수 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 동료의 Mainnet 배포에서 실제 사용자 수령을 확인하고 증거를 기록한다.

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

- 선행 작업: **00~10 통과 및 동료의 배포 환경 준비**.
- 전체 실행 순서: [실행 인덱스](../2026-10-09-season-canvas-nft.md).
- 정책 원본: [전체 스펙](../../specs/2026-10-09-season-canvas-nft-design.md), 2절.
- 공통 실행·테스트 규칙: [공통 계약](shared-contracts.md).
- 추가 질문 없이 적용할 최종 기술 결정: [구현 결정 계약](implementation-contract.md).

## 파일 소유권

변경 산출물: `docs/deployment/season-nft-acceptance.md`의 Mainnet 결과.
실행 담당: 사용자가 GitHub에 올린 코드를 동료가 본인 배포 환경에 배포한다.
새 비즈니스 코드 작성 단계가 아니다. 발견된 결함은 원인 작업 문서로 되돌려 수정하고 해당 검증을 재수행한다.

## 작업 11.1 — Mainnet 환경 준비와 수령 개방 확인

**인터페이스와 인계:** 입력: 10 runbook, mainnet-beta 전용 DB/키/RPC/영구 저장. 출력: 실제 작은 시즌의 READY.

### 구현 순서

- [ ] 1. Devnet과 분리된 DB·서비스 지갑·RPC 설정을 준비하고 nft:preflight를 실행한다. SEASON_NFT_ENABLED를 검증 없이 먼저 켜지 않는다.

- [ ] 2. 영구 snapshot 경로·upload work dir·secret key dir가 재배포에도 유지되는지 확인한다. restart 가능한 지속 worker가 있어야 한다.

- [ ] 3. 최초 개발 데이터 전환이 필요할 때만 01 dry-run과 expected count를 확인하고 초기화한다. Mainnet NFT 기록이 있으면 reset을 실행하지 않는다.

- [ ] 4. 최소2명 정원의 시즌과 실제 최소1시간 기간을 사용한다. 기능 검증을 위해 강제 종료하지 않는다.

- [ ] 5. 유효 획을 남기고 정상 종료를 기다린다. 최종 image hash, 공통 JSON URI, 대상 지갑/수량, 권한 잠금과 READY를 확인한다.


### 고정할 계약·핵심 구현

```bash
# 동료의 backend 배포 환경에서 실행한다. 비밀값은 secret 설정으로 주입한다.
SOLANA_NETWORK=mainnet-beta npm run nft:preflight
# 정상 종료 조건과 동일한 실제 시즌을 UI로 생성한다.
# READY 전에는 참가 지갑으로 mint를 시도하지 않는다.

```

### 검증과 완료 판정

devnet URL·주소·DB record 혼입 없음. URI는 영구 파일을 조회. READY는 모든 chain 설정의 finalized 검증 뒤에만 나타남.

실행 위치: backend.

```text
SOLANA_NETWORK=mainnet-beta npm run nft:preflight
```

기대 결과: Mainnet 준비와 자동 개방이 실제 환경에서 동작한다.

- [ ] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [ ] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 작업 11.2 — 실제 사용자 민팅과 인수 완료

**인터페이스와 인계:** 입력: READY 시즌, 참가 지갑 잔액. 출력: Mainnet 실제 asset/signature 및 최종 인수 기록.

### 구현 순서

- [ ] 1. 시즌 화면에서 비용을 확인하고 proof·mint를 사용자 지갑으로 승인한다. 실제 수수료는 사용자, 시즌 공통 준비는 서비스 지갑이 부담한다.

- [ ] 2. finalized signature와 asset을 explorer/chain 조회로 확인하고 시즌/프로필의 수령 완료가 같은지 검사한다.

- [ ] 3. 중복 받기 요청이 새 자산을 만들지 않는지 확인한다. 불필요한 실패 거래를 반복 전송하지 않는다.

- [ ] 4. 이미지·metadata URI·최초 수령 지갑·asset 주소를 acceptance 문서에 기록한다. 개인키나 인증 cookie는 기록하지 않는다.

- [ ] 5. 서비스 이상이면 ingress에서 claim-attempts 생성 POST만 일시 차단하고 상태 조회·기존 서명 제출·worker reconciliation은 유지하는 운영 절차를 실행한다. SEASON_NFT_ENABLED=false로 전체 worker를 끄는 것을 같은 조치로 취급하지 않는다. NFT를 DB 삭제로 되돌릴 수 있다고 안내하지 않는다.

- [ ] 6. 개발 완료·Devnet 검증·Mainnet 인수 세 상태를 각각 확정하고 미완료 항목이 없을 때만 실제 발행 완료라고 보고한다.


### 고정할 계약·핵심 구현

```markdown
- 환경: mainnet-beta
- 배포 commit:
- 시즌 ID:
- 최종 이미지 SHA-256:
- metadata URI:
- Core asset 주소:
- finalized mint signature:
- 시즌/프로필 표시 확인:
- 중복 수령 차단 확인:
- 검증 담당·시각:

```

### 검증과 완료 판정

성공 transaction이 실제 mainnet-beta에서 조회되고 meta.err=null. 동일 claim에 추가 성공 asset 없음. 브라우저 새로고침 후에도 CLAIMED 유지.

실행 위치: backend.

```text
실제 UI 수령 + Mainnet explorer 확인 + 서버 DB read-only 대조
```

기대 결과: 사용자가 요청한 실제 발행까지 완료했다는 증거를 남긴다.

- [ ] 의도한 이유로 실패하는 테스트를 먼저 확인한 뒤 구현하고, 같은 테스트의 통과를 확인한다. 문서·운영 체크 항목은 실제 증거로 판정한다.

- [ ] 관련 diff를 검토하고 변경 파일·검증 명령·결과·남은 외부 의존성을 인계 기록에 남긴다. 커밋한다면 해당 작업 변경만 포함하며 push하지 않는다.

## 다음 작업으로 넘길 증거

- 완료 조건: 지갑 자금 지출과 배포는 동료 환경의 실행 작업이다. 현재 문서 작성 세션에서는 실행하지 않는다.

- 변경 파일 목록과 commit 또는 diff 식별자.
- 실행한 테스트 명령과 결과. 외부 미실행 항목은 이유를 별도로 기록.
- 후속 작업이 소비할 타입·상태·API의 변경 유무.
- 정책 변경 없음 또는 해결한 설계 충돌의 근거.

## 확정된 실행 상세

- 실비가 드는 실행 담당은 배포 동료다. 자동 AI 확인은 read-only가 기본이며 사용자 지갑 승인은 해당 지갑 사용자가 UI에서 수행한다.
- 인수 시즌은 정원2명, 정상 기간 최소1시간, 기여 지갑2개다. 두 참여자가 유효 획을1개 이상 남기고 각자1개를 수령한다.
- Devnet 서비스 키를 Mainnet에 복사하지 않는다. Mainnet DB에 Devnet release/receipt가 섞였으면 시작하지 않는다.
- 서비스 준비 비용과 사용자 proof/mint 비용은 각 거래의 payer로 확인한다. 발행 가격과 royalty 설정이 없음을 chain 설정·metadata에서 확인한다.
- 읽기 검증 자료는 network/genesis, releaseId, seasonId, snapshot SHA-256, image/metadata URI, collection/machine/guard 주소, 두 asset과 mint signature, finalized 확인 시각이다.
- 수령 후 동일 지갑의 UI/HTTP 재요청으로 새 attempt나 asset이 생기지 않는지 확인한다. Mainnet 소각·타인 전송 실험을 필수로 추가하지 않는다. 해당 검증은00의 Devnet 증거를 사용한다.
- 잘못된 Mainnet release는 DB 삭제로 다시 발행하지 않는다. 새 수령 접수만 차단하고 이미 전송된 거래 확인은 유지하면서 원인을 보고한다.
- 전체 worker를 끄는 feature disabled를 접수 차단 대신 쓰지 않는다. ingress에서 생성 POST만 차단하고 조회·기존 서명 submit은 유지한다.
- 완료 조건은 두 Mainnet mint finalized, 동일 metadata, 시즌/프로필 표시 일치, 중복 차단, 서비스 비밀값 노출 없음이다. 모두 PASS여야 하며 Devnet signature로 대체할 수 없다.


## 인수 준비 검토 — 2026-10-10

배포 담당자와 독립 리뷰어, 주 담당자가 [인수 기록](../../../deployment/season-nft-acceptance.md)의 준비 문서를 교차 검토했다. 문서 준비는 PASS이며 **실제 11단계는 NOT_RUN**이다. 위 실행 체크박스는 완료 처리하지 않는다.

인수 기록에는 실제 배포 commit과 프론트·백엔드 연결, 10개 preflight 검사, 지속 경로 재배포 증거, 재사용할 Devnet 중복·외부 지갑·재시작·전송·소각 증거, 두 Mainnet 자산과 finalized 거래, payer·메타데이터·화면·중복 방지 증거를 기록하는 칸을 마련했다. 모든 실제 실행 값은 NOT_RUN으로 남겼다.

현재 외부 진행 조건은 동료의 배포 URL·실제 배포 commit·읽기 검증 접근 또는 내보낸 결과, Devnet 체인·저장소 검증 결과, 지갑 사용자의 직접 서명이다. 먼저 실제 Devnet 검증을 완료한 뒤 Mainnet 인수를 수행한다. 비밀키나 인증키를 인수 기록에 포함하지 않는다. 배포·자금 지출·서명·초기화는 이번 로컬 구현에서 수행하지 않았다.
