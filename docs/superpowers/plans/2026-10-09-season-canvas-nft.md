# 시즌 캔버스 NFT 작업별 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자가 병렬 실행을 선택하면 superpowers:subagent-driven-development를 사용한다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정상 종료한 시즌의 유효 기여자가 참가 지갑으로 최종 이미지 NFT를 한 번 수령하는 기능을 단계별로 구현한다.

**Architecture:** 기존 auth/seasons/canvas 경계를 확장하고 SeasonNftsModule에서 준비·민팅·복구를 소유한다. PostgreSQL에 작업을 저장하고 하나의 leader가 RPC 처리량을 관리한다. 공통 수령 UI를 시즌과 프로필에서 재사용한다.

**Tech Stack:** 기존 NestJS·pg·React·Wallet Standard, 검증 후 고정한 Metaplex Core/Candy Machine/Guard 및 Turbo SDK.

## Global Constraints

- 이 묶음은 실행 계획과 단계별 구현 검증 기록이다. 로컬 구현 통과는 실제 배포·민팅 완료를 뜻하지 않는다.
- [원본 설계](../specs/2026-10-09-season-canvas-nft-design.md)의 REQ-001~024와 INV-01~10이 제품 계약이다.
- backend Node >=24.21.0 <25, 시즌 정원2..100, 정상 종료만, 유효 획1개 이상, 사용자당1개, 참가 지갑 고정.
- 사용자 실비 부담·무기한 수령·공통 불변 metadata·로열티 없음·무료 RPC 시작 정책을 유지한다.
- 작업 전 [공통 계약](2026-10-09-season-canvas-nft/shared-contracts.md)과 선택한 작업 문서를 함께 읽는다.

## 문서 사용법

1. 원본은 정책·전체 계약을 읽는 기준이다. 아래 파일은 실제 작업 범위·경계·검증 기준이다.
2. 각 문서는 2~3개 검토 가능한 작업으로 나뉜다. 체크리스트 한 항목이 여러 코드 경로를 포함하면 구현 시작 시 그 항목을 더 작은 테스트/수정 단위로 나누되 완료 조건을 바꾸지 않는다.
3. 기본 실행은 번호순이다. 00 검증이 미완료이면 아래 독립 개발 허용 범위를 제외한 체인 연동 작업을 완료 처리하지 않는다.
4. 담당 AI에는 공통 계약, 해당 작업 문서, 지정된 원본 절을 함께 전달한다. 전체 대화 기록은 필요하지 않다.
5. [구현 결정 계약](2026-10-09-season-canvas-nft/implementation-contract.md)을 함께 적용한다. DB·API·상태 전이·SDK 실패·운영 인자에 대한 추가 결정은 이 문서에 고정했다.
6. 계획은 12개 작업 문서, 25개 검토 단위로 구성된다. 각 작업 문서의 체크박스와 구현 검증 기록을 현재 상태로 사용한다.

## 실행 순서

| 문서 | 선행 조건 | 검토 단위 | 독립 산출물 |
| --- | --- | --- | --- |
| [00-sdk-validation](2026-10-09-season-canvas-nft/00-sdk-validation.md) | 없음 | 2 | SDK 호환성 및 권한 잠금 검증 |
| [01-wallet-binding](2026-10-09-season-canvas-nft/01-wallet-binding.md) | 없음. 00과 독립 개발 가능 | 2 | 인증 지갑 및 시즌 참가 지갑 고정 |
| [02-persistence](2026-10-09-season-canvas-nft/02-persistence.md) | 01 완료 | 2 | NFT 상태 모델과 DB 불변 조건 |
| [03-freeze-snapshot](2026-10-09-season-canvas-nft/03-freeze-snapshot.md) | 01·02 완료. Merkle SDK 연결은 LOCAL_SDK PASS 필요 | 2 | 정상 종료 판정과 최종 이미지·수령 대상 확정 |
| [04-permanent-media](2026-10-09-season-canvas-nft/04-permanent-media.md) | 02·03 완료. 실제 Turbo 게시 연결은 00 검증 필요 | 2 | 공통 메타데이터 생성과 영구 파일 게시 |
| [05-worker-runtime](2026-10-09-season-canvas-nft/05-worker-runtime.md) | 02 완료 | 2 | PostgreSQL 워커와 RPC 처리량·거래 복구 기반 |
| [06-onchain-release](2026-10-09-season-canvas-nft/06-onchain-release.md) | 02~05 산출물 필요; 실제 체인 검증은 CHAIN_AUTHORITY PASS | 2 | 시즌 발행 환경 생성·권한 잠금·자동 개방 |
| [07-read-api](2026-10-09-season-canvas-nft/07-read-api.md) | 01·02 완료. fixture로 구현 가능 | 2 | 시즌 NFT 조회와 프로필 참여 시즌 API |
| [08-claim-transactions](2026-10-09-season-canvas-nft/08-claim-transactions.md) | 02·05·06·07 계약 필요; 실제 체인 검증은 CHAIN_AUTHORITY PASS | 3 | 사용자 수령 시도·서명 검증·민팅 복구 |
| [09-frontend-claim](2026-10-09-season-canvas-nft/09-frontend-claim.md) | 01·07·08 API 계약 완료. 최종 통합은08 완료 필요 | 2 | 공통 수령 UI와 시즌·프로필 연결 |
| [10-handoff-verification](2026-10-09-season-canvas-nft/10-handoff-verification.md) | 01~09 완료. 00 Devnet 증거 필수 | 2 | 운영 도구·배포 인계·Devnet 통합 검증 |
| [11-mainnet-acceptance](2026-10-09-season-canvas-nft/11-mainnet-acceptance.md) | 00~10 통과 및 동료의 배포 환경 준비 | 2 | 동료 배포 후 실제 Mainnet 발행 인수 |

## 의존성과 중단 기준

- 외부 실행 검증 전에도 01 인증 지갑,02 DB,03 reader/자격 SQL,04 순수 JSON/fake uploader,05 worker/fake chain,07 API fixtures,08 API·서명검사,09 fixture UI,10 운영 문서를 구현한다.
- 03 Merkle 생성은00 LOCAL_SDK,04 실제 게시는STORAGE_RECOVERY,06/08 실제 chain 통합 검증은CHAIN_AUTHORITY 증거를 소비한다. 전체 overallStatus 하나로 독립 작업을 막지 않는다.
- 09 UI는 07·08의 고정 API와 fixture로 먼저 작성할 수 있으나 완료에는 실제 통합 검증이 필요하다.
- 00에서 잠금 후 민팅 또는 불변성 검증이 실패하면 기술 선택을 재검토한다. 요구사항을 낮추거나 미검증 함수를 상상해 후속 계획을 완료하지 않는다.
- 10은 개발 및 배포 인계, 11은 동료 환경의 실제 Mainnet 인수다. 둘의 완료 상태를 합치지 않는다.
- 저장소 권한·지갑·잔액·외부 계정이 없으면 해당 실행만 미완료로 기록한다. 독립적으로 가능한 코드/로컬 테스트까지 중지할 필요는 없다.

## 요구사항 추적

| 원본 요구사항 | 구현 작업 | 최종 증거 |
| --- | --- | --- |
| REQ-001 시즌만 | 03,07 | 후보/조회 배제 테스트 |
| REQ-002 유효 획 | 03 | usage 자격 테스트 |
| REQ-003 최종 이미지 | 03,04 | head/PNG hash 검증 |
| REQ-004 직접 수령·비용 | 08,09,11 | 지갑 서명 및 비용 증거 |
| REQ-005 자동 지급 없음 | 06,08 | READY까지만 서비스 준비 |
| REQ-006 구현 가능한 스펙 | 전체 | 단계별 완료 기록 |
| REQ-007 정원 | 03,00 | 최대100 proof size 검증 |
| REQ-008 1회 수령 | 02,08 | 경쟁/전송/소각 후 차단 |
| REQ-009 참가 지갑 | 01,08,09 | 지갑 mismatch 테스트 |
| REQ-010 무기한 | 06,10 | endDate 없음·운영 보존 |
| REQ-011 전송 가능 | 00,11 | Core transfer 증거 |
| REQ-012 정상 종료 | 03,07 | 강제 종료 영구 제외 |
| REQ-013 신규 시즌 | 01,10 | 초기화 및 migration 검사 |
| REQ-014 실비만 | 06,08,11 | 가격 guard 없음·비용 확인 |
| REQ-015 로열티 없음 | 04,06 | metadata/plugin 설정 검사 |
| REQ-016 자동 개방 | 03~06 | 종료 후 READY E2E |
| REQ-017 실제 Mainnet | 00,10,11 | 실제 asset/signature |
| REQ-018 전체 수령 UI | 08,09 | 실제 wallet E2E |
| REQ-019 시즌·프로필 | 07,09 | 실제 목록·상태 동기화 |
| REQ-020 공통 정보 | 04,06 | metadata 동일성 |
| REQ-021 정보 불변 | 00,06 | 잠금 후 변경 거절 |
| REQ-022 신규 환경 준비 | 10 | runbook/preflight |
| REQ-023 동료 배포 | 10,11 | GitHub 인계/동료 인수 |
| REQ-024 무료 RPC | 05,10 | 공유 limiter·429 복구 |

요구사항 번호와 설명은 원본 2절을 최종 기준으로 한다. 구현 중 원본 변경 시 이 표도 함께 갱신한다.

## 작업 지시문

```text
시즌 캔버스 NFT의 [작업 번호]를 구현한다.
먼저 공통 계약, 구현 결정 계약, 해당 작업 문서와 명시된 원본 절을 읽는다.
선행 단계의 증거를 확인하고 이 작업의 파일·책임 범위만 변경한다.
제품 정책과 구현 기본값을 다시 질문하지 않는다. 실제 SDK 검증이 필요한 항목은 00의 선택·실패 규칙으로 검증하며 추정으로 대체하지 않는다.
실패 재현 테스트, 구현, 검증 순서로 진행하고 checkbox를 실제 결과로 갱신한다.
최종 보고: 변경 파일, 검증 명령/결과, 완료된 인계 계약, 미실행 외부 검증.
코드를 push하거나 실제 배포하는 작업은 포함하지 않는다.
```

## 구현 기준

2026-10-10 기준 backend `ca0554b`, frontend `bd58aca`를 대상으로 한다. [09의 최신 main 기준 보완](2026-10-09-season-canvas-nft/09-frontend-claim.md)과 [구현 결정 계약](2026-10-09-season-canvas-nft/implementation-contract.md)을 적용한다.

00부터 검증과 구현을 진행하고 미실행 외부 검증은 분리 기록한다. 체크된 항목은 해당 작업의 구현 검증 기록으로 확인하며, 체크되지 않은 항목은 미완료다. 실제 SDK 검증과 Mainnet 발행을 완료한 것으로 해석하지 않는다.

현재 로컬 구현·교차 검토 완료: **00.1 SDK 계약 및 검증 도구, 01 지갑 연결, 02 DB 영속성, 03 최종 스냅샷·자격 확정, 04 메타데이터·저장 복구 로직, 05 워커·거래 복구 기반, 06 발행 환경·권한 잠금의 로컬 구현, 07 NFT·참여 시즌 조회 API, 08 사용자 수령·서명·거래 복구, 09 공통 수령 UI·참여 목록 및 세 진입점의 로컬 검증, 10 운영 도구·배포 인계와 로컬 통합 검증**. 00·04·06 외부 검증, 배포 endpoint의 실제 RPC 네트워크 확인 및 10의 실제 Devnet 인수·11의 실제 Mainnet 인수는 미완료이며 실제 Mainnet 발행 완료를 뜻하지 않는다.
