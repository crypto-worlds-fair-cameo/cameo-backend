# 시즌 캔버스 참여자 NFT 수령 구현 스펙

작성일: 2026-10-09
상태: 사용자 검토용 상세 설계 초안. 제품 정책은 확정했으며 기술 설계와 실행 검증 기준을 포함한다. 구현 및 실제 발행 완료를 의미하지 않는다.

## 1. 목적과 사용 방법

시즌 캔버스에 기여한 사용자가 시즌 종료 시점의 최종 그림을 NFT로 수령한다.
사용자는 수령 버튼을 누르고 자신의 Solana 지갑에서 민팅 거래에 서명하며 민팅 비용을 부담한다.

이 문서는 후속 구현 AI가 대화 이력 없이 기능을 순서대로 구현할 수 있는 단일 진입점이 된다.
최종본은 정책, 시스템 경계, 데이터 모델, API 계약, 작업 순서, 실패 복구, 테스트 및 운영 조건을 포함해야 한다.
구현 AI는 제품 정책을 임의로 변경하지 않는다. SDK 호환성 및 운영 환경의 검증 실패는 단계 0과 배포 인계 규칙에 따라 보고한다.

### 1.1. 작업 저장소

- 백엔드: `/Users/simon.choi/work-space/solanaton/backend`
- 프론트: `/Users/simon.choi/work-space/solanaton/frontend`
- 사용자 제공 경로의 `work-spcae`는 실제 디렉터리 확인 결과 `work-space`다. 코드매퍼가 프론트 경로 존재와 해당 저장소의 `AGENTS.md`를 확인했다.
- 아래 백엔드 파일 경로는 별도 표시가 없으면 백엔드 루트 기준이다. 프론트 파일 경로는 프론트 루트 기준임을 명시한다.
- 후속 구현 AI는 두 저장소의 작업 규칙과 변경 상태를 각각 확인하고, 백엔드 계약과 프론트 소비자를 같은 단계의 완료 조건으로 검증한다.

## 2. 사용자와 확정한 요구사항

| ID | 요구사항 |
| --- | --- |
| REQ-001 | NFT 기능은 시즌 캔버스에만 적용한다. |
| REQ-002 | 해당 시즌에 유효한 획을 1개 이상 남긴 사용자를 수령 대상으로 한다. |
| REQ-003 | NFT 이미지는 시즌 종료 시점의 최종 캔버스 이미지다. |
| REQ-004 | 참여자가 수령을 요청하면 본인 지갑에서 민팅 거래에 서명하고 실제 민팅 비용을 부담한다. |
| REQ-005 | 시즌 종료 시 일괄 자동 지급하지 않는다. |
| REQ-006 | 스펙에 구현 단계와 각 단계의 검증 가능한 완료 조건을 명시한다. |
| REQ-007 | 참여자 규모는 기존 시즌 캔버스 생성 시 정한 제약을 따른다. NFT 기능에서 별도의 참여 인원 상한을 임의로 도입하지 않는다. |
| REQ-008 | 사용자당 시즌별 NFT 수령은 1개로 제한한다. 발행 실패 시 재시도를 허용하되 성공 이후 추가 발행은 허용하지 않는다. |
| REQ-009 | NFT는 해당 시즌에 참여한 검증된 Solana 지갑으로만 수령한다. 다른 지갑 선택 또는 수령 권한 이전은 제공하지 않는다. |
| REQ-010 | NFT 수령 기한은 없다. 수령 개방 이후 시간이 지나거나 다음 시즌이 시작되어도 미수령 권한은 만료되지 않는다. |
| REQ-011 | 수령한 NFT는 다른 지갑으로 전송하거나 판매할 수 있다. 서비스 내 거래소 구현은 이번 범위에 포함하지 않는다. |
| REQ-012 | 예정된 종료 시각까지 진행하여 정상 종료한 시즌만 NFT를 제공한다. 조기 종료한 시즌은 제외한다. |
| REQ-013 | NFT 기능 도입 이후 생성한 시즌부터 적용한다. 개발 중인 버전의 기존 시즌 데이터는 초기화할 수 있으며 과거 시즌 소급 적용은 구현하지 않는다. |
| REQ-014 | 사용자는 실제 민팅 비용만 부담하며 서비스는 별도 발행 가격을 받지 않는다. 이미지 보관 및 시즌별 발행 준비 비용은 서비스가 부담한다. |
| REQ-015 | NFT의 2차 판매 로열티는 설정하지 않는다. 로열티 수취 지갑, 수익 배분 및 정산 기능은 구현하지 않는다. |
| REQ-016 | 정상 종료 후 최종 이미지, 수령 대상 및 온체인 발행 설정의 준비가 완료되면 운영자 승인 없이 자동으로 수령을 개방한다. 준비 실패 시 수령을 개방하지 않고 재시도한다. |
| REQ-017 | 최종 목표는 Solana Mainnet에서 실제 NFT 발행 및 참여 지갑 수령까지 완료하는 것이다. Devnet에서만 동작하는 것으로 전체 구현 완료를 판정하지 않는다. |
| REQ-018 | 백엔드뿐 아니라 프론트의 NFT 수령 화면 구현도 포함한다. 실제 화면에서 자격·비용 확인, 지갑 서명, 발행 진행 및 완료 확인까지 연결한다. |
| REQ-019 | 종료된 시즌 상세·캔버스 화면과 프로필의 참여 시즌 목록 모두에서 NFT를 수령할 수 있다. 프로필 참여 시즌 목록을 실제 API와 연결하는 작업을 포함한다. |
| REQ-020 | NFT에는 최종 캔버스 이미지와 공통 시즌 정보만 담는다. 같은 시즌의 참여자 NFT는 동일한 메타데이터를 사용하며, 최초 수령자 지갑이나 개인 기여 획 수를 포함하지 않는다. |
| REQ-021 | 수령 개방 이후 NFT 이미지·이름·설명 및 메타데이터를 수정할 수 없다. 운영자에 의한 오탈자 수정도 허용하지 않는다. |
| REQ-022 | 운영용 서비스 지갑, RPC 및 NFT 저장 서비스는 현재 준비되어 있지 않다. 기술 구성 선정과 신규 생성·설정·자금 준비·연결 검증 절차를 구현 스펙에 포함한다. |
| REQ-023 | 사용자가 GitHub에 코드를 올리고 동료가 자신의 배포 환경에 배포한다. 구현 산출물에 배포 인계 문서를 포함하며, 특정 클라우드 신규 구축이나 AI의 직접 배포를 기본 범위로 잡지 않는다. |
| REQ-024 | 초기 RPC는 무료 요금제로 시작한다. 요청 제한에 맞춘 처리·재시도·사용량 관측을 구현하고 유료 전환은 운영자가 별도로 결정한다. |

### 2.1. 시즌별 1회 수령의 의미

- 수령 권한의 식별자는 `(season_id, user_id)`다. HTTP 요청이나 거래 시도마다 새 권한을 만들지 않는다.
- 서로 다른 시즌에는 각각 1개씩 수령할 수 있다.
- 같은 시즌에서 획을 여러 개 남겨도 수령 가능 수량은 증가하지 않는다.
- 성공한 최초 발행이 수령 권한을 소진한다. 지갑 변경, NFT 전송 또는 소각으로 수령 권한을 복원하지 않는다.
- 서명 취소나 체인에서 확정된 거래 실패는 수령 완료로 처리하지 않는다.
- 거래 제출 이후 결과가 불명확하면 기존 거래와 발행 기록을 먼저 확인한다. 응답 유실만으로 실패를 단정하거나 별도 NFT를 발행하지 않는다.
- 동시 요청과 여러 탭의 요청에서도 성공한 발행은 최대 1개여야 한다. DB 제약과 온체인 제한의 구체적 조합은 NFT 표준 확정 단계에서 정한다.
- 본 정책의 사용자는 기존 인증 체계의 `user_id`다. 여러 계정을 가진 실제 인물을 식별·통합하는 기능을 의미하지 않는다.

### 2.2. 수령 지갑 정책

- 수령 자격에는 시즌에 참여한 사용자의 검증된 Solana 지갑 하나를 연결한다.
- 수령 요청 body의 임의 주소나 수령 시 새로 연결한 지갑으로 수령 대상을 교체하지 않는다.
- 사용자 서명에 사용하는 지갑과 최초 NFT 수령 지갑은 확정된 참여 지갑과 같아야 한다.
- 다른 지갑으로 로그인해 별도 사용자가 된 경우 원래 사용자의 수령 권한을 승계하지 않는다.
- 지갑 분실 시 다른 지갑으로 수령 권한을 옮기는 복구 기능은 이번 구현 범위에서 제외한다.
- 이 정책은 최초 발행 대상에 관한 것이다. 발행 후 전송과 판매는 REQ-011에 따라 허용한다.
- 현재 지갑 구조는 일반 로그인 흐름에서 사용자당 하나지만 DB는 복수 지갑을 허용한다. 10절에 따라 로그인 지갑을 세션에 연결하고 참가 트랜잭션에서 고정한다. 복수 지갑 중 임의의 첫 행을 선택하지 않는다.

### 2.3. 수령 기간과 유지 조건

- 수령 개방 시점은 최종 이미지와 발행 준비가 완료된 시점이다. 단순히 시즌 종료 시각이 지났다고 즉시 민팅을 허용하지 않는다.
- 수령 만료 시각을 설정하지 않는다. API, 백그라운드 작업 및 온체인 설정에 기간 만료 조건을 추가하지 않는다.
- 다음 시즌 시작, 시즌 목록에서의 비노출 또는 보관 처리만으로 기존 수령 권한을 삭제하지 않는다.
- 민팅 거래의 서명 유효기간과 수령 권한의 유효기간을 구분한다. 거래가 만료되어도 미수령 권한은 유지된다.
- 거래 재생성 전에는 기존 거래의 성공 및 만료 여부를 확인하여 REQ-008을 지킨다.
- 미수령 권한에 필요한 발행 설정, 자격 명단, 이미지 및 메타데이터를 경과 시간만으로 정리하지 않는다.
- 저장소와 발행 방식 선택 시 장기 수령 가능성을 유지하는 운영 방안을 포함한다.
- 일시 장애와 준비 실패는 권한 만료가 아니다. 복구 후 동일한 권한으로 다시 수령할 수 있어야 한다.
- REQ-013에 따라 기능 도입 이전 시즌에는 수령 자격을 소급 생성하지 않는다. 무기한 수령 정책은 기능 적용 대상 시즌에만 해당한다.

### 2.4. 발행 후 소유권과 참여 기록

- 참여 지갑에 최초 발행한 후에는 소유자가 NFT를 전송하거나 판매할 수 있다. 참여 지갑 귀속 또는 양도 금지 제약을 넣지 않는다.
- 서비스 내 판매 등록, 구매, 거래 중개 및 거래소 UI는 구현하지 않는다.
- 외부 지갑과 거래소의 지원 여부는 NFT 표준 선택 시 확인한다. 전송 가능하다는 정책이 모든 외부 서비스의 표시·상장 지원을 보장하지는 않는다.
- 수령 완료는 최초 발행 성공 기록으로 판정한다. 현재 지갑에 해당 NFT가 없다는 이유로 미수령 상태로 되돌리지 않는다.
- NFT를 구매하거나 양도받은 소유자에게 원래 시즌의 참여 자격이나 추가 민팅 권한이 생기지 않는다.
- 시즌 기여 기록과 현재 NFT 소유권을 구분한다. NFT 보유만으로 해당 사용자가 원본 그림에 기여했다고 판정하지 않는다.
- REQ-015에 따라 NFT 판매 로열티를 설정하지 않는다. 프로토콜에서 로열티 정보가 선택 사항이면 생략하고 필수라면 0으로 설정한다. 선택할 표준의 정확한 설정 방식은 기술 설계에서 명시한다.
- 로열티 수취 지갑 등록, 참여자별 판매 수익 배분, 정산 및 로열티 강제 목적의 전송 제한을 추가하지 않는다.
- 로열티 없음은 외부 거래소 자체 수수료 면제를 뜻하지 않는다.

### 2.5. 시즌 종료 사유에 따른 발행 자격

- 정상 종료는 취소 또는 강제 종료 이력이 없고 예정된 `ends_at`에 도달한 경우다. 서버 시각 판단은 기존 시즌 정책의 DB 시각 기준을 따른다.
- `force_ended_at`이 설정된 시즌은 NFT 준비 및 수령 대상에서 제외한다. 이후 원래 `ends_at`이 지나도 정상 종료 시즌으로 재분류하지 않는다.
- 취소된 시즌도 정상 종료가 아니므로 NFT를 제공하지 않는다.
- 조기 종료 시즌의 최종 스냅샷이 `READY`여도 NFT 발행 자격을 부여하지 않는다. 최종 이미지 존재와 정상 종료 여부를 별도로 검사한다.
- 기존 조기 종료 처리와 스냅샷 생성은 유지한다. NFT 정책에 맞추기 위해 기존 캔버스 보관 동작을 제거하지 않는다.
- 시즌 발행 준비 대상 조회와 사용자 수령 처리 모두 같은 정상 종료 조건을 적용한다. 부적격 시즌에 직접 API를 호출해도 민팅 거래나 유효한 민팅 권한을 제공하지 않는다.
- 아직 진행 중이거나 시작 전인 시즌은 수령을 열지 않는다. 정상 종료 이후 최종 이미지 및 발행 준비가 완료되어야 수령 가능하다.

이 정책의 필수 인수 조건:

1. 정상 종료 + 유효 기여자 + 최종 이미지 준비 완료인 경우 후속 발행 준비 대상으로 처리한다.
2. 조기 종료 + 최종 이미지 준비 완료인 경우에도 발행 준비 및 수령을 허용하지 않는다.
3. 조기 종료 이후 원래 종료 시각이 지난 경우에도 발행 준비 및 수령을 허용하지 않는다.
4. 취소된 시즌은 유효 기여 기록이나 스냅샷 존재와 무관하게 제외한다.
5. 정상 종료했어도 최종 이미지 준비 전에는 수령 가능 상태로 표시하지 않는다.

### 2.6. 기능 도입과 개발 데이터 초기화

- 기능 도입 이후 생성된 시즌부터 신규 참여 지갑 기록 및 NFT 발행 정책을 적용한다.
- 기존 시즌의 참여 지갑을 추정하거나 과거 NFT 수령 권한을 복원하는 backfill은 구현하지 않는다.
- 사용자는 현재 개발 중인 버전의 기존 데이터를 삭제해도 된다고 명시했다. 구현 스펙에는 기존 시즌 데이터 초기화 절차를 포함한다.
- 초기화 대상 테이블, 외래 키 삭제 순서, 스냅샷 파일 및 실행 대상 환경은 코드와 배포 구성을 확인하여 구체적으로 명시한다.
- 사용자·인증 데이터와 시즌 외 캔버스까지 초기화해야 하는지는 의존 관계를 확인한 뒤 범위를 정한다. 기존 시즌 데이터 삭제 허용을 무관한 데이터 전체 삭제로 확대하지 않는다.
- 초기화는 개발 버전 전환을 위한 명시적 작업으로 제공한다. 애플리케이션 시작 시마다 실행하거나 일반 마이그레이션 실행 시 무조건 데이터를 삭제하는 동작을 넣지 않는다.
- 초기화 이후 시즌 생성, 참가, 획 저장, 정상 종료 및 NFT 수령까지 신규 데이터로 검증한다.
- 이 스펙 작성 단계에서는 실제 데이터를 삭제하지 않는다.

### 2.7. 최초 민팅 비용 부담

- 사용자는 자신의 민팅에 필요한 네트워크 거래 수수료, NFT 계정 생성 비용 및 선택한 프로토콜의 필수 발행 비용을 부담한다.
- 선택한 민팅 방식에서 사용자별 수령 증명 또는 제한 카운터 계정 생성이 필요하면 해당 비용도 민팅 비용에 포함하여 안내한다.
- 서비스는 민팅 가격, 서비스 수수료 또는 준비 비용 회수를 위한 추가 금액을 사용자에게 청구하지 않는다.
- 이미지·메타데이터 게시 및 보관, 시즌별 컬렉션·발행 환경 설정 등 공통 준비 비용은 서비스가 부담한다. 사용자 민팅 거래에 공통 준비 비용을 섞지 않는다.
- 서명 전에 필요한 예상 총비용을 안내한다. 비용 항목, 추정 방법 및 견적 갱신 조건은 NFT 표준 확정 후 API와 클라이언트 계약에 명시한다.
- 잔액 부족으로 민팅을 실행할 수 없으면 수령 완료로 처리하지 않는다. 사용자가 잔액을 보충한 후 동일한 권한으로 재시도할 수 있어야 한다.
- 거래 실패와 수령 권한 소진을 구분한다. 실패 시 비용 처리에 관한 안내는 선택한 체인의 실제 동작을 확인하여 작성하며 모든 실패가 무료라고 가정하지 않는다.
- 최초 민팅에 별도 발행 가격이 없고(REQ-014), 2차 판매에도 서비스가 설정하는 로열티가 없다(REQ-015). 두 정책을 별도로 유지한다.

### 2.8. 자동 준비와 수령 개방

- 정상 종료 시즌을 자동 감지하여 최종 스냅샷 준비 완료를 확인하고 NFT 준비 작업을 수행한다.
- 수령 개방 전에 정상 종료 여부, 최종 스냅샷과 이미지 해시, 확정된 기여 사용자 및 참여 지갑, 게시된 이미지·메타데이터, 온체인 발행 설정의 일치를 확인한다.
- 준비 요청 접수나 온체인 거래 전송만으로 수령 가능 상태로 전환하지 않는다. 필요한 외부 작업의 성공을 확인한 후 개방한다.
- 운영자의 시즌별 승인 버튼이나 수동 승인 상태를 정상 처리 경로에 추가하지 않는다.
- 준비 중에는 사용자에게 준비 중 상태를 표시하고, 민팅을 실행할 수 있는 거래나 권한을 제공하지 않는다.
- 일시적 실패는 자동 재시도한다. 단계별 진행 상태와 이미 생성한 외부 자산 식별자를 저장하여 재시작 후에도 이어서 처리한다.
- 이전 준비 거래의 결과가 불명확하면 체인 상태를 확인한 뒤 다음 행동을 결정한다. 응답 유실을 이유로 같은 시즌의 발행 설정을 무조건 새로 생성하지 않는다.
- 잘못된 설정이나 서비스 지갑 잔액 부족 등 복구 전까지 반복되는 실패는 원인을 기록하고 운영자에게 드러낸다. 세부 재시도 간격, 횟수 및 복구 진입점은 작업 상태 설계에서 명시한다.
- 준비 실패는 정상 종료한 시즌의 자격이나 사용자 수령 권한을 만료시키지 않는다. 원인 해소 후 동일한 시즌 준비를 이어갈 수 있어야 한다.
- 한 시즌의 NFT 준비 실패가 다른 시즌의 진행과 준비를 막지 않아야 한다.
- 수령 대상이 0명인 정상 종료 시즌의 완료 상태와 온체인 준비 생략은 기술 설계에서 정의한다. 대상자가 없는 상태를 준비 실패로 무한 재시도하지 않는다.

이 정책의 필수 인수 조건:

1. 정상 종료와 준비 완료만으로 운영자 승인 없이 수령 가능 상태가 된다.
2. 최종 이미지, 메타데이터 또는 온체인 설정 중 하나라도 준비되지 않으면 수령을 개방하지 않는다.
3. 준비 단계 중 프로세스를 재시작해도 진행 상태를 복구하고 동일한 시즌에 중복 발행 환경을 생성하지 않는다.
4. 준비 중 사용자 요청으로 조기 민팅을 실행할 수 없다.
5. 준비 완료는 자동 NFT 지급을 의미하지 않는다. NFT는 REQ-004에 따라 사용자가 직접 수령할 때 발행한다.

### 2.9. 검증 환경과 실제 발행 목표

- Devnet은 테스트용 네트워크이며 여기서 발행한 NFT는 Mainnet의 실제 발행 결과가 아니다.
- 최종 인수 대상은 Mainnet에서 정상 종료 시즌의 유효 기여자가 본인 지갑으로 비용을 지불하고 NFT 1개를 수령하는 흐름이다.
- 구현 순서는 로컬 자동 테스트, Devnet 통합 검증, 운영 설정 준비, Mainnet 실제 발행 검증으로 구성한다.
- Devnet의 NFT를 Mainnet으로 이전하는 절차로 설계하지 않는다. Mainnet에서 해당 환경의 이미지·메타데이터 및 발행 설정으로 새로 발행한다.
- 네트워크별 RPC, 서비스 지갑 설정, 컬렉션·발행 설정 주소, 거래 기록과 수령 상태를 분리한다. Devnet 수령 기록이 Mainnet 수령 권한을 소진해서는 안 된다.
- Mainnet 발행 전에 서비스 준비 비용을 지급할 지갑과 사용자 민팅 비용을 지급할 참여 지갑에 실제 SOL이 필요하다. 준비 비용과 민팅 비용의 부담 주체는 REQ-014를 따른다.
- 실제 발행 검증에서도 참여 자격과 정상 종료 정책을 우회하지 않는다. 유효한 획을 남긴 검증용 시즌을 정상 종료하여 동일한 경로로 발행한다.
- 발행 거래와 자산 주소를 근거로 발행 성공, 최초 수령 지갑 및 해당 시즌의 이미지·메타데이터 일치를 확인한다. 같은 사용자의 추가 발행이 차단되는지도 검증한다.
- Mainnet 실행에 필요한 자격 증명, 지갑 자금 또는 서비스가 준비되지 않았다면 준비된 코드와 미완료 운영 단계를 구분하여 보고한다. Devnet 성공을 Mainnet 발행 성공으로 보고하지 않는다.
- 현재 작업은 스펙 작성이다. 이 단계에서 Mainnet 거래를 실행하거나 실제 비용을 지출하지 않는다.

#### Devnet 검증과 Mainnet 인수의 구분

- Devnet 성공은 구현 검증의 선행 조건이며 Mainnet 성공을 보장하지 않는다. 네트워크별 계정·잔액·발행 설정 및 RPC 운영 조건이 다르다.
- 같은 구현과 고정한 의존성 버전을 사용하되, 선택한 NFT 프로그램이 두 네트워크에서 필요한 기능을 제공하는지 각각 확인한다.
- Mainnet 인수 전에 프로그램 및 컬렉션·발행 설정 주소, 권한, 실제 SOL 잔액, 공개 메타데이터 접근, 프론트와 서버의 네트워크 일치를 검증한다.
- RPC 지연·요청 제한·거래 만료를 정상 운영 중 발생 가능한 상태로 처리한다. 네트워크 환경 차이로 재시도가 발생해도 중복 발행을 허용하지 않는다.
- 소규모 Mainnet 검증 시즌에서 실제 수령을 먼저 확인한 뒤 일반 사용자의 시즌에 적용한다. 해당 검증 역시 정상 종료 및 기여 조건을 따른다.
- 참고: [Solana 네트워크 구분](https://solana.com/docs/references/clusters), [운영용 RPC 선택](https://solana.com/docs/rpc/providers). 문서 확인일: 2026-10-09.

### 2.10. 프론트 수령 화면 범위

- 종료된 시즌에서 최종 이미지, 수령 자격 및 준비·수령 상태를 확인할 수 있어야 한다.
- 자격이 있는 미수령 사용자는 예상 비용을 확인하고 참여 지갑으로 민팅 거래에 서명할 수 있어야 한다.
- 준비 중, 수령 불가, 지갑 불일치, 잔액 부족, 서명 취소, 거래 확인 중, 재시도 가능 및 수령 완료를 구분하여 표시한다.
- 새로고침이나 화면 재진입 이후에도 서버 및 체인에서 확인한 상태를 복원한다. 프론트 메모리의 성공·실패 값만으로 완료를 판정하지 않는다.
- 발행 성공 시 NFT 자산과 거래 확인 링크를 제공하며 현재 환경과 다른 네트워크의 탐색기 링크를 만들지 않는다.
- 프론트 저장소는 1.1절의 경로다. 시즌 화면은 `src/pages/season-canvas/`, 라우트는 `src/app/router/route-config.tsx`, 헤더 지갑 인증은 `src/app/layout/header/`에 있다. 확인된 연동 지점은 4.2절을 따른다.
- `src/pages/profile/api/profile.api.ts`의 기존 `minted` 표시는 샘플 데이터다. REQ-019에 따라 참여 시즌 목록과 NFT 수령 상태는 실제 API로 교체한다. 무관한 프로필 통계·계정 기능 전체 개편은 포함하지 않는다.

#### 수령 진입점과 상태 일치

- `SeasonDetailDialog`와 종료된 시즌의 `SeasonWorkspacePanel`에 참여자용 수령 진입점을 제공한다. 개설자 전용 관리 권한과 수령 자격을 혼동하지 않는다.
- 프로필의 `JoinedCanvases`에서 로그인 사용자가 참여한 시즌을 실제 데이터로 조회하고 시즌별 준비 상태, 수령 자격 및 수령 결과를 표시한다.
- 프로필 목록 조회는 서버의 인증 사용자 기준으로 수행한다. 클라이언트가 전달하는 다른 사용자 ID를 그대로 신뢰하지 않는다.
- 개설자도 유효한 획을 남겼을 때만 동일한 참여자 수령 흐름을 사용한다. 기존 개설자용 ‘NFT 만들기’ placeholder가 별도 발행 권한이나 중복 진입 흐름으로 남지 않도록 관련 표시를 정리한다.
- 두 화면은 동일한 자격 판정과 민팅 처리 구현을 공유한다. 화면별로 별도 수령 권한이나 독립적인 민팅 구현을 만들지 않는다.
- 한 화면에서 민팅이 시작되거나 완료되면 해당 시즌의 수령 상태와 프로필 목록 상태를 갱신한다. 다른 탭의 중복 요청은 백엔드 및 온체인 제한으로도 방어한다.
- 목록의 수령 완료 표시는 최초 민팅 성공 기록을 따른다. NFT를 전송한 이후에도 수령 완료를 유지한다.
- 과거 시즌에서도 수령할 수 있으므로 프로필 참여 시즌 조회에 진행 중인 시즌만 반환하는 제한을 두지 않는다. 정렬·페이지네이션 계약은 API 설계에서 명시한다.
- 샘플 데이터의 `minted` 또는 `strokeCount` 값으로 실제 민팅 자격을 부여하지 않는다. 서버가 반환한 자격과 상태를 사용한다.

이 정책의 필수 인수 조건:

1. 같은 유효 기여자가 시즌 상세, 종료된 캔버스 및 프로필 목록에서 같은 수령 자격을 확인한다.
2. 어느 진입점에서든 민팅에 성공하면 다른 진입점도 수령 완료로 갱신된다.
3. 참여만 하고 획을 남기지 않은 사용자는 두 화면 모두에서 민팅할 수 없다.
4. 다른 사용자로 로그인하면 이전 사용자의 목록 및 수령 상태가 남지 않는다.
5. 여러 화면에서 동시에 요청해도 해당 시즌의 사용자별 NFT는 최대 1개만 발행된다.

### 2.11. 공통 시즌 이미지와 메타데이터

- 시즌별 최종 이미지 하나와 공통 메타데이터 하나를 준비하여 모든 참여자의 NFT가 동일한 내용을 참조하도록 한다.
- NFT 자산 주소와 소유권은 개별 자산마다 별도로 존재한다. 같은 메타데이터를 사용한다고 하나의 NFT를 공동 소유하는 구조로 만들지 않는다.
- 메타데이터에 최종 캔버스 이미지, 시즌 이름, 정상 종료일 등 공통 시즌 정보를 포함한다. 정확한 필드, 이름 길이 제한, 날짜 표현 및 설명 문구는 선택한 NFT 표준과 기존 시즌 모델에 맞춰 기술 설계에서 정의한다.
- 최초 수령자의 지갑 주소, 사용자 ID, 닉네임, 개인 기여 획 수 또는 사용자별 링크를 메타데이터에 넣지 않는다.
- 참여자 명단이나 수령 자격 증명을 NFT 메타데이터에 첨부하지 않는다. 자격 검증용 기록 및 온체인 소유권 정보와 NFT 표시용 정보를 구분한다.
- 수령 시점이나 사용자별로 별도 메타데이터 JSON을 생성하지 않는다. 재시도에서도 동일한 시즌 메타데이터를 참조한다.
- 사용자별 일련번호나 기여량에 따른 등급·희소성 차이를 추가하지 않는다.
- 공통 메타데이터는 REQ-021에 따라 수령 개방 이후 수정할 수 없다. 구체적인 불변 저장 및 온체인 변경 제한 방식은 기술 설계에서 확정한다.

이 정책의 필수 인수 조건:

1. 같은 시즌의 서로 다른 참여자 2명이 수령한 NFT는 자산 주소가 다르고 이미지 및 메타데이터 URI는 같다.
2. 공통 메타데이터에 개인 지갑 주소, 사용자 ID, 닉네임 또는 개인 기여 획 수가 포함되지 않는다.
3. 사용자 수령 시점이 달라도 동일한 시즌 메타데이터를 사용한다.

### 2.12. 수령 개방 이후 정보 불변성

- 수령 개방 전에 최종 PNG, 메타데이터 JSON, NFT 이름 및 각 파일의 해시·URI를 확정한다.
- 개방 이후에는 같은 URI의 파일 내용을 덮어쓰거나 NFT가 참조하는 URI를 다른 주소로 교체하지 않는다.
- 변경 가능한 애플리케이션 API 응답이나 덮어쓰기 가능한 로컬 파일 URL을 최종 NFT 메타데이터의 유일한 원본으로 사용하지 않는다.
- 운영자 수정 API를 제공하지 않는 것만으로 요구사항이 충족되지는 않는다. 선택한 NFT 표준에서 온체인 이름·URI 변경을 막는 설정도 구현해야 한다.
- 아직 수령하지 않은 참여자의 NFT도 개방 시 확정한 이름과 URI를 사용한다. 발행 설정을 바꿔 후속 수령자에게 다른 내용을 발행할 수 없도록 하는 방식까지 기술 설계에서 검증한다.
- 준비 중에는 생성 결과를 검증하며, 불일치나 잘못된 메타데이터가 있으면 개방하지 않는다. 운영자 승인 단계 없이 자동 검증과 준비 완료 조건으로 보호한다.
- 개방 후 시즌 화면의 제목 또는 설명이 수정되더라도 이미 확정한 NFT 정보를 다시 생성하거나 동기화하지 않는다. 시즌 편집 가능 여부 자체는 기존 정책을 따른다.
- 전송·판매 허용 정책은 유지한다. 정보 불변성을 위해 소유자의 NFT 전송까지 차단하지 않는다.
- 콘텐츠 변경 불가와 지속 접근 가능성을 구분한다. 저장 방식에는 불변성을 유지하면서 이미지와 메타데이터를 장기 보관하는 운영 방안도 포함한다.

이 정책의 필수 인수 조건:

1. 같은 시즌에서 수령 개방 직후와 나중에 발행한 NFT의 이름·이미지·메타데이터가 같다.
2. 운영자 권한으로도 개방 이후 온체인 이름·URI를 변경할 수 없도록 선택한 표준의 설정을 검증한다.
3. 게시한 PNG와 JSON의 실제 내용이 저장한 해시와 일치한다.
4. 서비스 내부 시즌 정보 변경이 기존 NFT의 고정된 정보를 변경하지 않는다.
5. 불변 정보 설정 이후에도 정상적인 NFT 전송이 가능하다.

### 2.13. 구현 완료와 배포 인계

- 구현 AI는 백엔드와 프론트 코드, DB 변경, 환경 설정 예제, 검증 결과 및 배포 인계 문서를 준비한다.
- GitHub 업로드는 사용자가, 실제 운영 배포는 동료가 수행하는 흐름이다. 현재 요청으로 AI가 원격 저장소에 push하거나 운영 환경을 변경하는 작업을 시작하지 않는다.
- 특정 클라우드 계정, Terraform, Kubernetes 또는 새 호스팅 구매를 필수 산출물로 추가하지 않는다. 실행에 필요한 환경 계약을 문서로 제공하여 동료의 환경에서 구성할 수 있게 한다.
- 완료 상태를 두 단계로 구분한다. `개발 인계 완료`는 코드·자동 테스트·Devnet 통합 검증·배포 문서가 준비된 상태다. `실제 발행 인수 완료`는 동료의 배포 환경에서 Mainnet 발행을 확인한 상태다.
- REQ-017의 Mainnet 실제 발행 목표는 유지한다. 코드만 준비되거나 Devnet만 통과한 상태를 실제 발행 완료로 보고하지 않는다.
- 인계 문서에는 설정 항목별로 백엔드·프론트 구분, 필수 여부, 예시, 비밀 여부, 생성 또는 획득 방법, 잘못 설정됐을 때의 증상을 명시한다.
- 서비스 지갑 생성·자금 준비, RPC 계정·키 발급, 저장 서비스 준비는 운영 환경 설정 절차로 안내한다. 자격 증명이나 실제 비밀값을 문서 또는 GitHub에 포함하지 않는다.
- DB 초기화 및 스키마 적용, 서버·프론트 배포, 외부 연결 확인, NFT 기능 활성화, 소규모 Mainnet 수령 확인의 순서를 명시한다.
- 동료에게 전달할 문서가 특정 로컬 절대 경로에만 의존하지 않도록 실행 디렉터리와 환경변수로 경로를 설정한다.
- 배포 후에도 준비 작업이 계속 실행될 수 있는 프로세스와 재시작 복구 조건, PostgreSQL 및 스냅샷 저장소의 지속성 조건을 명시한다.

## 3. 상세 설계 개요

- 최종 이미지와 수령 대상 명단을 고정한 뒤 수령을 개방한다.
- Metaplex Core, Core Candy Machine 및 Candy Guard로 발행·자격·1회 제한을 구성한다.
- 공통 이미지와 JSON은 Arweave/Turbo로 게시하고, 준비된 발행 설정과 NFT 정보의 변경 권한을 잠근다.
- 로그인 지갑을 세션에 연결하고 시즌 참가 시 저장한다.
- 체인 거래는 기록 후 전송하며, 성공 여부를 확인하기 전에는 재발행하지 않는다.
- 무료 RPC의 전체 호출 예산을 하나의 DB leader worker가 관리한다.
- 구체적 상태·데이터·API·프론트·실행 단계는 9~20절을 따른다. 실제 발행 목표 환경은 Mainnet이다.

## 4. 코드매퍼가 확인한 현재 구조

확인일: 2026-10-09. 소스 탐색 결과이며 실행 검증 결과가 아니다.

| 책임 | 근거 파일 | 확인 내용 |
| --- | --- | --- |
| 시즌 조기 종료 | `src/modules/seasons/features/end-season/end-season.use-case.ts` | 종료 gate와 승인 좌표 저장을 거쳐 종료를 확정한다. |
| 최종 이미지 생성 | `src/modules/canvas/resources/canvas-snapshot/canvas-snapshot-runner.ts` | 스냅샷 기능 활성화 시 자연 종료 후보도 주기적으로 조회하고 최종 이미지 생성을 시도한다. |
| 최종 이미지 정합성 | `src/modules/canvas/resources/canvas-snapshot/canvas-snapshot.repository.ts` | 최종 발행 시 종료 여부 및 저장된 canvas head와 스냅샷 범위 일치를 검증한다. |
| 유효한 획 기록 | `src/modules/canvas/resources/canvas-stroke-usage/canvas-stroke-usage.repository.ts` | `canvas_stroke_usages`에서 시즌별 기여 사용자를 추출할 수 있다. |
| 검증된 지갑 | `src/modules/auth/resources/wallet-account/wallet-account.repository.ts` | 지갑 로그인 흐름이 있다. DB는 사용자당 복수 지갑을 허용하나 현재 연결 API와 대표 지갑 필드는 없다. |
| 과거 기획 | `docs/project.md` | 대표 cNFT와 참여증명 cNFT를 구분한 이전 기획이 존재한다. 현재 요구사항과 구별해야 한다. |
| 시즌 정원 | `src/modules/seasons/resources/season/season.ts:66`, `db/migrations/2026-10-06-01-seasons.sql:88` | 필수 입력 `capacity`는 정수 2~100이며 기본값은 없다. 도메인과 DB에서 제약한다. |
| 참가 정원 집행 | `src/modules/seasons/features/join-season/join-season.use-case.ts:52` | 시즌 행 잠금 후 참가자 수를 확인하므로 동시 참가에서도 정원을 넘지 않는다. |

### 4.1. 수령 대상 규모

- 사용자가 지정한 규모 기준은 기존 시즌 생성 입력 `capacity`다.
- `capacity`는 개설자를 포함한 누적 참가 등록 수의 상한이다. 동시 접속 수가 아니다.
- 개설자는 시즌 생성 트랜잭션에서 자동 참가하며 정원 한 자리를 사용한다.
- 현재 참가 탈퇴 또는 자리 반환 경로는 없다.
- 획 추가는 유효한 시즌 참가자에게만 허용되므로 유효 기여자 수는 참가 등록 수 이하이다.
- 따라서 수령 자격을 가진 사용자 수는 `0 <= eligibleUserCount <= capacity <= 100`이다.
- 참가 등록만 하고 획을 남기지 않은 사용자와 획을 남기지 않은 개설자는 수령 대상에서 제외한다.
- 발행 준비 시 실제 유효 기여자 수를 사용한다. `capacity` 자체를 수령 대상 수로 간주하거나 빈 자리에 수령 권한을 만들지 않는다.
- REQ-008에 따라 시즌별 최대 발행량은 실제 유효 기여자 수이며 최대 100개다. 수령하지 않은 사용자의 몫은 발행하지 않는다.
- 유효 기여자가 0명인 시즌은 11~12절에 따라 EMPTY로 완료하고 온체인 준비를 생략한다.

주의사항:

- `season_participants`는 입장 기록이므로 NFT 수령 자격의 근거로 사용하지 않는다.
- `completed_at`은 획의 마지막 chunk 종료 표식이다. 종료되지 않은 획과 무효 획을 동일하게 취급하지 않는다.
- 스냅샷 기능 기본 설정은 비활성화다. 수령 개방의 운영 선행 조건을 명시해야 한다.
- 현재 스냅샷은 로컬 파일 저장소를 사용한다. NFT 이미지와 메타데이터의 지속 보관 방식은 별도 설계한다.
- 기존 지갑 로그인 서명 검증과 NFT 거래 서명·전송·확인은 별개 기능이다.
- NFT 발행 상태, 수령 상태 및 거래 복구 처리는 새로 설계해야 한다.

### 4.2. 프론트 코드매퍼 탐색 결과

아래 경로는 프론트 저장소 루트 기준이다. 소스 확인 결과이며 화면 실행 검증은 하지 않았다.

| 책임 | 파일 | 확인 내용 |
| --- | --- | --- |
| 라우트 | `src/app/router/route-config.tsx:30` | `/season-canvas`, `/season-canvas/:seasonId`, `/profile`이 있다. |
| 시즌 상세 | `src/pages/season-canvas/ui/SeasonDetailDialog.tsx:126` | 개설자 조기 종료 영역이 있다. NFT 수령은 개설자 전용 행동과 분리해야 한다. |
| 시즌 작업공간 | `src/pages/season-canvas/ui/SeasonWorkspacePanel.tsx:95` | 종료 시 읽기 전용 표시와 오류·재시도 UI가 있다. 수령 UI 후보 지점이다. |
| 시즌 API | `src/pages/season-canvas/api/seasons.api.ts` | 기존 시즌 API 호출 구현을 따른다. |
| 지갑 로그인 | `src/app/layout/header/lib/wallet-standard.ts:48` | Wallet Standard의 `solana:signIn`을 사용한다. NFT 거래 서명·전송은 구현되어 있지 않다. |
| 세션 정보 | `src/entities/session/api/session.api.ts:4` | 인증 사용자와 지갑 목록을 받는다. |
| 공통 HTTP | `src/shared/api/http-client.ts:12` | Axios와 10초 timeout을 사용한다. 자격 증명 전송은 개별 API 설정도 확인해야 한다. |
| 참여 시즌 표시 | `src/pages/profile/ui/JoinedCanvases.tsx:11` | 참여 시즌·기여 획 수 UI가 있으나 현재 프로필 데이터는 샘플이다. |
| 개설 시즌 NFT 버튼 | `src/pages/profile/ui/MySeasons.tsx:13` | 기존 ‘NFT 만들기’는 개설자 대상 placeholder다. 참여자 수령 정책의 구현으로 간주하지 않는다. |

추가 확인 및 구현 기준:

- 시즌 상세 query는 탭이 보일 때 30초 간격으로 갱신하고, workspace는 시즌 상태 이벤트에서 상세 query를 무효화한다. 준비 상태 조회에는 이 패턴을 재사용할 수 있으나 민팅 확인 주기는 별도로 정한다.
- 지갑 로그인 성공은 민팅 거래 서명 기능 지원을 의미하지 않는다. 선택한 지갑 계정 및 거래 서명 기능을 확인하는 흐름이 필요하다.
- 현재 헤더는 세션의 첫 Solana 지갑 주소를 표시한다. NFT 수령은 이 표시값을 신뢰하지 않고 서버가 고정한 참여 지갑과 실제 서명 계정을 비교해야 한다.
- 기존 시즌 API 요청은 cookie 인증을 사용하며 참여 지갑 주소가 매번 전달되는 구조가 아니다. 참여 지갑을 고정할 백엔드 계약을 구현 단계에서 명시해야 한다.
- 수령 자격과 수령 상태는 사용자별 데이터다. 공개 시즌 정보 cache와 혼동하지 않고 로그아웃·계정 변경 시 이전 사용자의 상태와 진행 중 작업이 잘못 표시되지 않도록 정의한다.
- 프론트 검증 명령은 `npm run test`, `npm run lint`, `npm run build`다. 실제 수행 결과는 후속 구현 단계에서 기록한다.
- REQ-019에 따라 시즌 화면과 프로필 참여 시즌 목록 모두에 수령 기능을 연결한다. 프로필 참여 시즌 데이터와 해당 수령 상태는 실제 API로 전환한다.

### 4.3. 상세 계약과 배포 구성 추가 탐색

코드매퍼의 읽기 전용 확인 결과다. 아래는 백엔드 루트 기준이다.

| 영역 | 근거 | 설계에 반영할 사실 |
| --- | --- | --- |
| 인증 사용자 문맥 | `src/modules/auth/resources/session/session-authenticator.ts:7` | 인증 결과에 사용자 ID는 있으나 로그인 지갑 주소·walletAccountId는 없다. |
| 세션 저장 | `src/modules/auth/resources/session/session.repository.ts:17` | 현재 세션은 user_id와 token hash 중심이며 로그인 지갑을 구분해 저장하지 않는다. |
| 내 지갑 조회 | `src/modules/auth/features/me/me.use-case.ts:41` | `/auth/me`에서 별도로 사용자 지갑 배열을 조회한다. 첫 지갑이 현재 세션의 로그인 지갑이라는 증거는 아니다. |
| 개설자 자동 참가 | `src/modules/seasons/features/create-season/create-season.use-case.ts:42` | 시즌 생성 트랜잭션에서 userId로 참가자를 추가한다. |
| 일반 참가 | `src/modules/seasons/features/join-season/join-season.use-case.ts:37` | 참가 시 userId를 사용하며 지갑 주소를 고정하지 않는다. |
| 참가 레코드 | `src/modules/seasons/resources/season/season.repository.ts:80` | 참가 INSERT는 season_id, user_id, joined_at이다. 참여 지갑을 보관할 필드가 필요하다. |
| 성공 응답 | `src/http/response.interceptor.ts:11` | `{ statusCode, success: true, data }` 형태다. |
| 실패 응답 | `src/http/errors/http-exception.filter.ts:90` | `{ statusCode, success: false, code, message, traceId }` 형태다. |
| 인증 쓰기 요청 | `src/modules/seasons/features/end-season/end-season.controller.ts:36` | Origin 및 session cookie를 사용하는 기존 패턴을 따른다. |
| 페이지네이션 | `src/modules/seasons/features/list-seasons/list-seasons.controller.ts:23` | 시즌 목록은 offset 기반이다. 참여 목록 계약도 기존 구조와 함께 결정한다. |
| 로컬 트랜잭션 | `src/database/transaction/transaction-runner.ts` | `TransactionRunner.run`과 pg 트랜잭션 구현을 사용한다. |
| 프로필 백엔드 | `src/modules/user/resources/profile/profile.repository.ts:7` | 닉네임 변경만 있으며 참여 시즌 목록 API는 아직 없다. |
| 테스트 및 SQL 적용 | `test/canvas/database-fixture.cjs:74`, `test/canvas/README.md` | realtime 테스트 fixture는 db/migrations의 SQL을 사전순으로 적용한다. |

구현 상세화 기준:

- 로그인에서 검증한 지갑을 세션 문맥에 연결하고, create/join 트랜잭션에서 참여 지갑을 고정하는 범위를 설계한다. 지갑 배열의 첫 번째 주소를 임의로 선택하는 방식으로 대체하지 않는다.
- 기존 개발 데이터를 초기화하는 정책을 활용하여 과거 세션·참가 기록의 지갑을 추정하는 backfill을 추가하지 않는다. 초기화 범위는 실제 FK 및 인증 흐름에 맞춰 정한다.
- 신규 참여 시즌 목록은 14.5절에 따라 시즌 모듈에서 자격·상태와 함께 조회한다. 닉네임 변경만 담당하는 ProfileRepository에 NFT 처리 전체를 몰아넣지 않는다.
- 준비 진행 상태는 DB에 보관한다. 기존 snapshot runner의 메모리 timer만으로 NFT 외부 작업의 지속성을 보장한다고 가정하지 않는다.
- 현재 공개 배포 구성은 로컬 Postgres 16의 `docker-compose.yml`뿐이다. Dockerfile, CI 배포, AWS/Terraform/Kubernetes 등 운영 배포 설정은 확인되지 않았다.
- REQ-023에 따라 동료의 기존 배포 환경을 사용한다. 운영 서버 상품을 이 스펙에서 새로 선정하지 않고 필수 런타임·영구 저장·비밀 주입 계약을 제공한다.
- 백엔드 검증 명령은 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:realtime`이다. 외부 서비스 통합 검증은 별도로 추가한다.

## 5. 외부 입력과 검증할 조건

제품 정책 추가 질문 없이 구현할 수 있도록 기술 기본값은 9~18절에 정의했다. 다음 값은 코드가 임의 생성하거나 이미 준비됐다고 가정할 수 없는 운영 입력이다.

1. 동료 배포 환경의 API·프론트 URL, 허용 Origin 및 지속 저장 경로.
2. Devnet/Mainnet 서비스 지갑 파일과 각 환경의 RPC endpoint.
3. 저장 서비스 업로드·결제 endpoint 및 필요한 자금 또는 upload credit.
4. 실제 Mainnet 수령 검증을 할 참가 지갑과 실제 SOL 잔액.

설정 예제와 검사 스크립트를 먼저 완성하고 동료가 이 값을 주입한다. 운영 입력 부재로 실제 검증을 실행하지 못하면 코드 인계와 실행 인수를 구분하여 기록한다.

## 6. 최종 스펙에 포함할 구현 단계

아래는 전체 흐름 요약이다. 구현 파일과 검증 기준은 18절의 단계 0~9를 따른다.

1. 데이터 모델과 시즌 NFT 기능 경계 정의.
2. 최종 스냅샷 및 기여자 확정 처리.
3. 이미지·메타데이터 게시와 발행 환경 준비.
4. 수령 자격·상태 조회 계약 구현.
5. 사용자 서명용 민팅 거래 준비 및 클라이언트 연동.
6. 거래 검증·상태 반영·유실 복구.
7. 운영 제어, 재시도, 관측 및 배포 설정.
8. 통합 검증과 인수 조건 확인.

각 단계에는 다음 항목을 반드시 채운다.

- 선행 단계와 입력 조건.
- 담당 모듈, 변경 및 신규 파일.
- 입력·출력, 상태 전이 및 불변 조건.
- DB 제약, 트랜잭션 범위와 외부 시스템 부수 효과.
- 인증·권한 및 공개 오류 계약.
- 중복 요청, 타임아웃, 재시작 및 부분 성공 처리.
- 필수 테스트, 실행 명령과 통과 기준.
- 다음 단계로 넘기는 산출물.

## 7. 외부 서비스 구성 검토와 초기 준비

상태: 공식 문서 기반 기술 제안이다. 초기 RPC 무료 요금제는 REQ-024로 확정했다. 최종 SDK 계약은 추가 검증 중이며 계정 생성, 결제 또는 온체인 실행은 수행하지 않았다.

### 7.1. 상세 설계에서 사용하는 구성

| 구성 | 선택 | 역할 | 검증 조건 |
| --- | --- | --- | --- |
| NFT 및 자격 제한 | Metaplex Core + Core Candy Machine | 참여 지갑만 사용자 부담으로 발행하고 시즌별 1회로 제한 | 단계 0의 권한 잠금·민팅 검증 필수 |
| Solana RPC | Helius Free | Devnet/Mainnet 조회, 시뮬레이션, 전송 및 확정 확인 | 무료 시작 정책 확정. endpoint와 한도는 환경 설정으로 주입 |
| 불변 파일 보관 | Arweave + Turbo | 시즌별 PNG와 공통 JSON을 게시하고 장기 보관 | 게시 결과 재조회 및 SHA-256 일치 검증 |
| 서비스 지갑 | 환경별 전용 Solana 지갑 | 공통 발행 환경 준비와 파일 보관 비용 부담 | 신규 생성 필요. 배포 환경에 맞는 비밀 관리 방식 선정 필요 |

권고 이유는 현재 시즌당 수령 대상이 최대 100명이고, 개별 NFT를 소유·전송할 수 있으며, 자격과 1회 제한을 온체인에서도 적용해야 한다는 요구에 있다. 대규모 압축 NFT와 별도 커스텀 Solana 프로그램을 기본 구성으로 추가하지 않는다.

### 7.2. 확인된 기능과 추가 기술 검증

- Core Candy Machine의 Allow List 및 Mint Limit으로 고정 참여 지갑과 시즌별 최대 발행량 1을 적용한다.
- 동일한 이름과 URI를 사용하는 Hidden Settings가 있다. 이를 사용한다면 임시 이미지 후 공개하는 reveal 기능으로 사용하지 않고 처음부터 최종 콘텐츠를 지정한다. 사용자별 번호 치환 변수도 사용하지 않는다.
- Core에는 이름과 URI를 잠그는 ImmutableMetadata 기능이 있다. 불변 파일 저장과 온체인 변경 제한을 함께 적용해야 한다.
- 이미 발행한 자산의 불변성과 아직 발행하지 않은 자산의 설정 불변성은 별개다. 12.4절의 Candy Machine·Guard·Collection 관리 권한 잠금을 단계 0에서 검증한다. 운영 지갑에서 변경 API를 호출하지 않는다는 약속만으로 REQ-021을 충족했다고 판단하지 않는다.
- 무기한 수령 정책 때문에 미수령자가 남아 있는 발행 설정을 rent 회수 목적으로 닫지 않는다.
- Core 지갑 표시 및 거래소 지원은 실제 대상 지갑에서 검증한다. 전송 가능 정책이 모든 거래소의 상장 지원을 뜻하지는 않는다.
- Turbo의 운영 Arweave 보관과 개발용 임시 저장 환경을 구분한다. Mainnet 발행에는 개발용 임시 저장 URL을 사용하지 않는다.

### 7.3. 비용 검토 근거

문서 확인일: 2026-10-09. 아래 값은 설계 시 참고값이며 사용자에게 고정 민팅 가격으로 표시하지 않는다.

- Helius 공개 요금표: Free는 월 $0, 월 1M credits, RPC 10 requests/second, `sendTransaction` 1 request/second다. Developer는 월 $49, 월 10M credits, RPC 50 requests/second, 전송 5 requests/second다.
- 무료 RPC로 시작하더라도 Mainnet 발행과 영구 파일 게시까지 무료라는 뜻은 아니다. 실제 SOL 및 저장 비용 준비가 필요하다.
- RPC 등급을 시즌 정원만으로 결정하지 않는다. 동시에 종료되는 시즌 수, 상태 조회량, 재시도 및 전체 요청량도 영향을 준다.
- 유료 전환을 코드가 임의로 실행하지 않는다. 선택한 요금제의 한도에 맞춰 호출 제한 및 재시도를 설정하고 초과 상황을 관측한다.
- 서버 내부의 준비 작업, 사용자 거래 제출, 상태 확인이 같은 RPC 계정의 한도를 함께 소비한다는 전제로 호출 예산을 관리한다. 느린 파일 업로드는 별도 storage lane으로 처리하여 chain send/check를 막지 않는다. 요청마다 독립 limiter를 만들어 전체 한도를 초과하지 않는다.
- 같은 거래에 대한 화면별 polling은 DB의 확인 결과를 공유하고 서버가 체인 확인을 합친다. 페이지 진입마다 별도 무제한 RPC polling을 시작하지 않는다.
- HTTP 429 및 일시 장애는 지연 후 재시도하며, 화면에는 확인 중 상태를 유지한다. 단순 요청 제한을 거래 실패 또는 수령 완료로 처리하지 않는다.
- 준비 작업과 전송·확인 작업의 처리량 설정을 인계 문서에 명시한다. v1은 단일 backend replica와 지속 볼륨을 사용한다. 다중 replica와 자동 호스트 failover는 후속 검증 범위다.
- NFT 생성 총비용은 프로토콜 비용, 계정 생성 비용 및 거래 수수료 등의 합이다. 공식 수수료 표의 한 항목을 전체 사용자 비용으로 표시하지 않는다.
- 서비스 준비 비용은 시즌별 실제 계정 크기와 업로드 용량으로 추정한다. 구체적 예산과 입금액을 검증 없이 하드코딩하지 않는다.

### 7.4. 초기 준비 절차에 반드시 포함할 항목

1. Devnet과 Mainnet의 서비스 지갑을 별도로 생성하고 공개 주소를 환경별로 기록한다. 사용자 개인 지갑을 서버 서명키로 재사용하지 않는다.
2. 서비스 서명키의 저장 위치와 주입 방식을 실제 배포 환경에 맞춰 정한다. 저장소, 문서, 프론트 번들 및 로그에는 비밀키나 복구 문구를 넣지 않는다.
3. RPC 계정을 생성하고 각 네트워크 endpoint를 구성한다. 브라우저에 서버용 비밀 API 키가 노출되지 않도록 전송 경로 또는 제한된 클라이언트 접근 방식을 정의한다.
4. Arweave 업로드 환경을 준비한다. 게시 크기에 따른 견적, 자금 또는 업로드 credit 충전, 업로드 영수증 확인 및 실제 파일 재조회 검증을 포함한다.
5. Devnet에서 테스트 자금을 준비하고 최종 이미지 게시, 발행 준비, 수령, 중복 방지 및 재시작 복구를 검증한다.
6. Mainnet용 서비스 지갑에 준비 비용을, 참여 지갑에 개별 민팅 비용을 준비한다. 금액은 준비할 거래와 게시 파일의 실제 견적을 기준으로 안내한다.
7. 정상 종료한 소규모 Mainnet 시즌에서 실제 화면으로 수령하고 자산·거래·불변성 설정을 확인한다.
8. 공개된 자산 및 거래 식별자와 검증 결과만 완료 증거에 남긴다. 계정 가입이나 자금 준비가 필요한 상태를 실제 발행 완료로 표현하지 않는다.

### 7.5. 공식 참고 자료

- Core Candy Machine: https://www.metaplex.com/docs/smart-contracts/core-candy-machine/create
- Allow List: https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/allow-list
- Mint Limit: https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/mint-limit
- ImmutableMetadata: https://www.metaplex.com/docs/smart-contracts/core/plugins/immutableMetadata
- 발행 설정 변경과 권한: https://www.metaplex.com/docs/smart-contracts/core-candy-machine/update
- Helius 요금표: https://www.helius.dev/pricing
- Turbo 업로드 비용: https://docs.ar.io/build/upload/turbo-credits
- Turbo 업로드 및 확인: https://docs.ar.io/build/upload/upload-and-verify/
- Metaplex 프로토콜 수수료: https://github.com/metaplex-foundation/disclosures/blob/main/protocol-fees.md

### 7.6. 동료 배포용 인계 문서 계약

최종 구현 산출물에 `docs/deployment/season-canvas-nft.md`를 추가한다. 이 파일은 배포와 검증 절차를 담당하며 API 필드 명세를 중복하지 않는다.

필수 내용:

1. **버전과 의존성:** 백엔드·프론트의 호환되는 변경 버전, Node 런타임, 설치·빌드·테스트 명령.
2. **환경변수 표:** 네트워크, RPC, 업로드 서비스, 서비스 서명키 주입, 허용 Origin, API URL, 스냅샷 저장·공개 URL 및 기능 활성화 조건. Devnet 값을 Mainnet에 재사용하지 않도록 구분한다.
3. **외부 자원 준비:** 운영용 서비스 지갑, 자금, RPC endpoint 및 영구 파일 보관 설정을 준비하고 연결을 확인하는 절차.
4. **개발 데이터 초기화:** 실제 대상 환경을 식별하는 방법, 삭제할 테이블·파일 범위, FK 순서, 실행 명령 및 초기화 결과 확인. 서버 시작과 분리한 명시적 절차로 제공한다.
5. **스키마 및 애플리케이션 배포:** 쓰기 중지 필요 여부, SQL 적용 순서, 구버전과 신버전 혼용 금지 조건, backend/frontend 배포 순서 및 재로그인 필요 조건.
6. **실행 조건:** 지속 실행되는 준비·거래 확인 작업, 재시작 시 DB 상태 복구, 스냅샷 파일 유지, outbound RPC 및 저장 서비스 접근 조건.
7. **배포 후 확인:** 로그인, 시즌 생성·참가·획 저장, 정상 종료, 최종 PNG 생성, 자동 수령 개방, 실제 Mainnet NFT 발행 및 중복 수령 차단 확인.
8. **문제 해결:** 서비스 지갑 잔액 부족, RPC 요청 제한·지연, 업로드 실패, 잘못된 네트워크, 지갑 불일치 및 프로세스 재시작의 진단·복구 방법.
9. **중지와 되돌리기:** 새 준비·민팅 거래 제공을 중지하는 방법과 기존 작업 복구 절차. 이미 발행한 NFT와 지불한 비용은 코드 롤백으로 되돌아가지 않는다는 점을 명시한다. 잠긴 온체인 수령 권한을 서버 기능 플래그만으로 없앨 수 있다고 설명하지 않는다.
10. **인수 증거:** 사용한 네트워크, 시즌 ID, 최종 이미지 해시, 발행 설정 주소, 실제 자산·거래 주소 및 확인 결과. 비밀값은 포함하지 않는다.

인계 문서는 AI가 수행한 검사와 배포 담당자가 수행해야 할 검사를 구분한다. 실행하지 않은 Mainnet 검사에 완료 표시를 하지 않는다.

## 8. 문서 관리 원칙

- 이 문서는 설계 계약이다. 현재 제공되는 API 설명과 혼동하지 않는다.
- 구현 후 HTTP 필드 및 오류 명세의 기준은 Swagger decorator와 응답 모델이다.
- `docs/api/`에는 사용 흐름과 클라이언트 예제를 작성하며 상세 필드·오류 명세를 중복하지 않는다.
- API 오류 메시지는 영어, 설명은 한국어를 기본으로 한다.
- 구현 착수 전 미정 정책을 해소하고 전체 스펙을 사용자와 검토한다.

## 9. 상세 기술 설계의 기준

이 절 이후는 확정된 사용자 정책을 만족시키기 위한 구체적 설계안이다. 제품 정책은 2절을 기준으로 하며, 아래 기술 선택은 전체 스펙 검토 대상이다.

### 9.1. 구성과 책임

1. NFT 표준은 **Metaplex Core**, 발행기는 **Core Candy Machine**, 접근 제한은 **Core Candy Guard**로 구성한다.
2. 시즌마다 별도 Core Collection, Candy Machine 및 Candy Guard를 만든다. 모든 NFT가 같은 이름·URI를 사용하며 발행 상한은 확정된 유효 기여자 수다.
3. 파일은 **Arweave에 Turbo로 게시**한다. 최종 PNG와 공통 JSON 각각 한 번 게시하며 콘텐츠 주소 및 SHA-256을 저장한다.
4. RPC 초기 환경은 **Helius Free**다. 특정 endpoint를 코드에 하드코딩하지 않으며 서버가 조회·전송·확정을 담당한다.
5. 프론트는 Wallet Standard의 **`solana:signTransaction`**으로 서버가 만든 거래를 서명한다. 서명된 거래를 백엔드에 전달하고 백엔드가 검증·전송한다. 프론트 번들에 운영 RPC 비밀키나 서비스 서명키를 넣지 않는다.
6. 비동기 작업은 기존 PostgreSQL에 상태를 저장한다. 이번 기능을 위해 Redis·BullMQ 또는 별도 메시지 브로커를 필수로 추가하지 않는다.
7. 백엔드의 `SeasonNftsModule`이 시즌별 준비, 사용자별 수령, 외부 발행 및 복구를 소유한다. 기존 SeasonsModule은 시즌 수명과 참여 지갑을, CanvasModule은 최종 스냅샷을, AuthModule은 검증한 로그인 지갑을 소유한다.

### 9.2. 경계와 호출

- 정상 종료 판정과 참여자·획·스냅샷 상태의 조회는 같은 DB를 읽는 시즌 NFT query에서 수행할 수 있다. 다른 모듈의 private repository를 가져와 상태를 수정하지 않는다.
- 최종 PNG 파일의 경로 해석·파일 읽기·해시 검증은 CanvasModule이 공개하는 `FinalCanvasSnapshotReader`에서 수행한다. 기존 스냅샷 repository와 파일 처리 구현을 재사용한다.
- AuthModule의 `SessionAuthenticator`는 검증된 `walletAccountId`와 `walletAddress`를 제공하도록 확장한다. NFT 코드가 session cookie를 별도로 해석하지 않는다.
- 시즌 생성 및 참가 UseCase는 인증 문맥의 지갑을 기존 트랜잭션에서 참가 레코드에 고정한다.
- NFT 조회, 민팅 시도 생성, 서명 거래 제출은 서로 다른 독립 UseCase로 둔다. 파일 업로드나 개별 SQL마다 UseCase를 만들지 않는다.
- 프론트의 수령 기능은 `src/features/season-nft-claim/`에 모은다. 시즌 화면과 프로필은 이 기능을 소비한다. 각 화면이 서로를 import하지 않는다.

### 9.3. 불변 조건

| ID | 조건 |
| --- | --- |
| INV-01 | 정상 종료하고 취소·강제 종료되지 않은 시즌만 준비한다. |
| INV-02 | 최종 스냅샷의 마지막 sequence와 확정된 canvas head가 일치한 결과만 게시한다. |
| INV-03 | 수령 대상은 해당 canvas의 `canvas_stroke_usages`에 존재하는 사용자이며 참가 지갑은 고정값이다. |
| INV-04 | 같은 환경·시즌·사용자의 성공한 민팅은 최대 1회다. |
| INV-05 | 동일 환경·시즌의 모든 NFT는 같은 name·image URI·metadata URI를 사용한다. |
| INV-06 | 수령 개방 이후 기여 명단·지갑·최대 발행량·공통 NFT 정보는 변경하지 않는다. |
| INV-07 | RPC 응답 유실, 429 또는 시간 초과는 체인 실패의 증거가 아니다. |
| INV-08 | 전송·소각으로 수령 완료를 되돌리지 않는다. |
| INV-09 | DB rollback으로 외부 업로드나 체인 전송을 취소했다고 가정하지 않는다. |
| INV-10 | Devnet과 Mainnet은 DB·서명키·환경 설정을 분리한다. DB에 기록한 network와 실행 환경이 다르면 작업을 거절한다. |

## 10. 로그인 지갑과 시즌 참가 변경

### 10.1. 저장 계약

- `auth_sessions`에 `wallet_account_id uuid NOT NULL`을 추가한다.
- `user_wallets`에 `(user_id, id)` UNIQUE를 추가하고, 세션의 `(user_id, wallet_account_id)`가 해당 쌍을 참조하도록 한다. 다른 사용자의 지갑을 세션에 연결하지 못하게 한다.
- 로그인에서 서명을 검증하고 조회·생성한 `WalletAccount.walletId`를 세션 생성에 함께 전달한다.
- `SessionAuthenticationResult`에 `walletAccountId: string`, `walletAddress: string`, `chainNamespace: 'solana'`를 추가한다. 값은 세션과 지갑 JOIN 결과로 구성한다.
- `/auth/me`의 기존 응답 필드를 유지하면서 `activeWallet: { id: string; chainNamespace: 'solana'; address: string }`를 추가한다. 프론트 헤더는 첫 wallets 원소 대신 activeWallet을 현재 인증 지갑 표시로 사용한다.
- `season_participants`에 `wallet_account_id uuid NOT NULL`, `wallet_address text COLLATE "C" NOT NULL`을 추가한다. 사용자-지갑 복합 FK 및 `(season_id, wallet_address)` UNIQUE를 둔다.
- 지갑 주소는 Base58 문자열의 대소문자를 유지한다. Ethereum 방식의 소문자 정규화를 적용하지 않는다.
- 시즌 개설자의 자동 참가와 일반 참가 모두 같은 지갑 저장 계약을 적용한다.
- 이미 참가한 사용자의 재요청은 원래 지갑을 유지한다. 요청 시 다른 인증 지갑이 확인되면 `SEASON_PARTICIPATION_WALLET_MISMATCH`로 거절하고 참가 레코드를 덮어쓰지 않는다.
- 참여 지갑 필드를 변경하는 API는 제공하지 않는다. NFT 자격 확정 시 저장한 참가 지갑을 복사하며 현재 지갑 목록으로 재계산하지 않는다.

### 10.2. 기존 개발 데이터 처리

- 과거 세션과 시즌 참가 기록에는 지갑 연결 정보가 없으므로 신규 필드의 임의 backfill을 하지 않는다.
- 배포 인계 절차에서 기존 개발 세션을 무효화하고 기존 개발 시즌·그림 데이터를 초기화한 뒤 NOT NULL 제약을 적용한다. 사용자와 지갑 계정 자체는 보존한다.
- 정확한 삭제 대상은 기존 FK 관계에 따라 작성한 전용 초기화 스크립트에서 명시한다. `TRUNCATE ... CASCADE`로 관계없는 표까지 암묵적으로 지우는 방식을 사용하지 않는다.
- 기존 migration의 FK를 확인한 삭제 순서는 `canvas_stroke_chunks`, `canvas_snapshots`, `season_participants`, `canvas_stroke_usages`, `seasons`, `canvases(type='season')`다. 공유 테이블은 모두 대상 season canvas ID로 제한한다. auth_sessions는 독립적으로 전체 삭제할 수 있다.
- 삭제 전에 스냅샷의 image_key·continuation_key와 season canvas ID를 manifest로 기록한다. DB 삭제 commit 이후 해당 파일만 저장 루트 내부에서 제거한다. 저장 루트 전체 또는 main 캔버스 파일을 삭제하지 않는다.
- 초기화 시 애플리케이션과 snapshot/NFT worker를 중지한다. users, user_wallets 및 main canvas 데이터의 전후 개수가 유지되는지 검사한다.
- 이 초기화 도구는 새 NFT 데이터가 없는 최초 개발 버전 전환용이다. 이미 `season_nft_releases` 또는 온체인 발행 기록이 있으면 실행을 거절한다. Mainnet 발행 후 개발 초기화를 반복하지 않는다.
- 기존 열린 브라우저는 다시 로그인해야 한다. 구버전 세션은 401로 처리하고 프론트가 로그인 UI로 안내한다.

## 11. 시즌 발행과 수령 데이터 모델

식별자는 기존 프로젝트와 동일하게 UUID를 사용한다. 금액·block height·sequence는 bigint로 저장하고 JSON에서는 정밀도 손실을 피하도록 십진 문자열로 전달한다. 시간은 `timestamptz`, API는 UTC ISO 8601이다.

### 11.1. `season_nft_releases`

| 컬럼 | 타입·제약 | 의미 |
| --- | --- | --- |
| id | uuid PK | 발행 준비 식별자 |
| season_id | uuid NOT NULL FK seasons(canvas_id) RESTRICT | 시즌 |
| network | text CHECK devnet/mainnet-beta | 체인 환경 |
| state | text NOT NULL | WAITING_SNAPSHOT / PREPARING / READY / EMPTY / BLOCKED |
| stage | text NOT NULL | SNAPSHOT / FROZEN / IMAGE / METADATA / COLLECTION / MACHINE / LOCKED |
| snapshot_id | uuid NULL FK canvas_snapshots(id) RESTRICT | 확정한 최종 이미지 |
| through_sequence | bigint NULL | 최종 좌표 범위 |
| eligible_count | integer NULL CHECK 0..100 | 확정된 기여자 수 |
| frozen_title, frozen_description | text NULL | 게시 전 고정한 시즌 정보 |
| season_ended_at | timestamptz NULL | 원래 정상 종료 시각 |
| asset_name | text NULL | 모든 자산에 쓸 이름 |
| image_sha256, metadata_sha256 | text NULL | 게시할 정확한 바이트의 SHA-256 hex |
| image_uri, metadata_uri | text NULL | 고정한 공개 URI |
| collection_address, candy_machine_address, candy_guard_address | text NULL | 환경별 온체인 주소 |
| merkle_root | bytea NULL CHECK 32 bytes | 고정된 참여 지갑 집합의 root |
| locked_at, ready_at | timestamptz NULL | 체인 권한 잠금 확인 및 수령 개방 |
| retry_count | integer NOT NULL DEFAULT 0 | 현재 단계 재시도 수 |
| next_attempt_at | timestamptz NOT NULL | 다음 처리 시각 |
| last_error_code, last_error_message | text NULL | 비밀·원시 RPC URL을 제거한 운영 오류 |
| created_at, updated_at | timestamptz NOT NULL | 기록 시각 |

- UNIQUE `(season_id, network)`를 둔다. 반복 종료 감지는 같은 release를 사용한다.
- READY에는 snapshot, count>0, name, URI, hash, 모든 온체인 주소 및 locked_at이 필수다.
- EMPTY는 eligible_count=0이며 온체인 발행 주소를 만들지 않는다.
- 후보 검색용 `(state, next_attempt_at)` 인덱스를 둔다.
- READY 이후 상태 확인 시각 외에 확정 필드와 자격 명단을 바꾸지 않는다. 조회 동작이 준비 정보 재생성을 유발해서는 안 된다.

### 11.2. `season_nft_claims`

| 컬럼 | 타입·제약 | 의미 |
| --- | --- | --- |
| id | uuid PK | 수령 권한 |
| release_id | uuid NOT NULL FK season_nft_releases(id) RESTRICT | 시즌 발행 |
| network | text NOT NULL CHECK devnet/mainnet-beta | release와 일치하는 환경 |
| user_id | uuid NOT NULL FK users(id) RESTRICT | 원래 기여 사용자 |
| wallet_account_id | uuid NOT NULL FK user_wallets(id) RESTRICT | 참가 지갑 계정 |
| wallet_address | text COLLATE "C" NOT NULL | 고정된 수령 지갑 |
| state | text NOT NULL | UNCLAIMED / PROCESSING / CLAIMED |
| merkle_proof | jsonb NOT NULL | 선택한 SDK가 만드는 proof 바이트 배열 |
| asset_address | text NULL | 실제 발행한 Core 자산 주소 |
| mint_signature | text NULL | 확인한 최초 발행 거래 |
| claimed_at | timestamptz NULL | finalized 발행 확인 시각 |
| receipt_state | text NOT NULL | NONE / RESOLVING / VERIFIED |
| receipt_next_check_at | timestamptz NULL | RESOLVING 독립 재조회 시각; VERIFIED면NULL |
| receipt_retry_count | integer NOT NULL DEFAULT 0 CHECK >=0 | receipt 조회 backoff 횟수 |
| created_at, updated_at | timestamptz NOT NULL | 기록 시각 |

- UNIQUE `(release_id, user_id)`, UNIQUE `(release_id, wallet_address)`를 둔다.
- CLAIMED는 단조 상태다. 전송, 소각, RPC 오류 또는 화면 이탈로 UNCLAIMED로 바꾸지 않는다.
- 체인 MintCounter가 1인데 자산·거래 증거를 아직 조회하지 못했다면 CLAIMED + RESOLVING으로 막고 계속 복구한다. 새 민팅을 허용하지 않는다.
- VERIFIED에는 asset_address와 mint_signature가 필수다. claims에 network를 저장하고 `(network, asset_address)` UNIQUE를 둔다. releases의 `(id, network)` UNIQUE와 claims의 `(release_id, network)` 복합 FK로 환경 일치를 보호한다.

### 11.3. `season_nft_claim_attempts`

- `id uuid PK`, `claim_id uuid FK`, `state text`, `step text`, `created_at`, `updated_at`를 둔다.
- state: QUEUED / AWAITING_SIGNATURE / SUBMITTING / CONFIRMING / SUCCEEDED / EXPIRED / FAILED.
- step: ALLOWLIST_PROOF / MINT.
- `asset_address text NULL`, `last_error_code text NULL`, `next_attempt_at timestamptz`를 둔다.
- 종료 상태가 아닌 시도에 대해 claim_id UNIQUE partial index를 둔다. 여러 탭에서도 활성 시도는 하나다.
- proof 단계가 이미 체인에서 준비됐다면 MINT로 시작한다. proof 성공 후 같은 시도를 MINT 단계로 진행한다.
- 지갑 서명 취소는 수령 실패 확정이 아니다. 서명 대기 시도는 유지하여 다시 시도하거나 blockhash 만료 후 새 거래를 제공한다.

### 11.4. `season_nft_transactions`

- `id uuid PK`, `network text`, `release_id uuid FK`, `attempt_id uuid NULL FK`, `operation_key text NOT NULL`, `kind text NOT NULL`을 둔다.
- `message_hash text`, `serialized_transaction bytea`, `signature text NULL`, `recent_blockhash text`, `last_valid_block_height bigint`, `asset_address text NULL`을 저장한다.
- `state`: PREPARED / SIGNED / SUBMITTED / CONFIRMED / FINALIZED / RECONCILED / FAILED / EXPIRED.
- `created_at`, `updated_at`, `next_check_at`, `last_error_code`를 둔다. signature에는 네트워크별 UNIQUE를 둔다.
- 서비스 준비 거래와 사용자 거래 모두 **DB 기록 후 전송**한다. txId는 API에서 이 행의 UUID다.
- 같은 operation에는 진행 중 또는 FINALIZED/RECONCILED 거래를 합쳐 하나만 허용하는 partial UNIQUE를 둔다. 만료 시 과거 행을 덮어쓰지 않고 새 행을 만든다.
- 서명된 바이트는 자금 지출을 실행할 수 있는 자료이므로 로그에 출력하지 않는다. 사용자에게는 해당 사용자 소유의 미완료 거래만 반환한다.
- 서비스 준비 계정(Collection·Candy Machine 등)의 임시 keypair는 생성 직후 전용 지속 디렉터리에 원자적으로 저장한다. 디렉터리 0700, 파일 0600을 적용하며 public static 경로 아래에 두지 않는다. DB에는 공개 주소와 private 파일 식별자만 저장한다.
- 준비 거래가 만료되면 저장한 동일 keypair로 같은 계정에 대한 새 거래를 만든다. 공개 주소만 저장하고 재서명에 필요한 키를 잃어버리는 구현을 하지 않는다. 잠금과 READY가 확인된 뒤에만 임시 준비 키 정리를 허용한다.

### 11.5. `season_nft_uploads`

- release_id + kind(IMAGE/METADATA)에 UNIQUE를 둔다.
- `id uuid PK`, `sha256 text`, `byte_length bigint`, `data_item_id text`, `signed_item_path text`, `state text`, `uri text NULL`, `receipt jsonb NULL`, timestamps를 둔다.
- 업로드용 signed data item을 서버의 지속 저장 경로에 원자적으로 기록하고 식별자를 DB에 저장한 뒤 전송한다.
- 재시도는 동일 data item을 사용한다. 이미 게시된 ID의 내용을 재조회할 수 있으면 해시를 검사하고 이어간다.
- 게시 receipt만으로 끝내지 않고 최종 공개 URI를 읽어 원본 해시와 일치하는지 검사한다. 임시 sandbox 파일을 Mainnet URI로 기록하지 않는다.

## 12. 정상 종료부터 수령 개방까지

### 12.1. 후보 감지

- 워커 시작 시와 이후 60초마다 정상 종료 시즌을 검색한다.
- 조건은 canvases.type='season', `ends_at <= CURRENT_TIMESTAMP`, `cancelled_at IS NULL`, `force_ended_at IS NULL`이다. 시즌 기간은 canvases, 취소·강제 종료는 seasons의 실제 컬럼을 사용한다.
- 기존 release가 없으면 WAITING_SNAPSHOT으로 삽입한다. DB UNIQUE 충돌은 이미 접수된 것으로 처리한다.
- 최종 READY 스냅샷이 아직 없으면 대기한다. NFT 코드가 자체 PNG 렌더러나 임의 스냅샷을 생성하지 않는다.

### 12.2. 스냅샷과 대상 확정

1. CanvasModule의 공개 reader로 트랜잭션 밖에서 최종 스냅샷 ID·sequence·PNG bytes·SHA-256·크기를 확인한다.
2. 시즌과 release를 잠그고 정상 종료 조건과 snapshot ID/status/is_final 및 canvases.last_chunk_sequence를 다시 확인한다. 파일 I/O 동안 DB 락을 유지하지 않는다.
3. 해당 canvas의 usage를 사용자별 DISTINCT로 조회하고 season_participants의 고정 지갑과 LEFT JOIN한다. 누락 참가자를 조용히 제외하지 않는다. `completed_at IS NOT NULL` 조건을 추가하지 않는다.
4. 고정 지갑이 없거나 user-wallet 관계가 잘못된 행이 있으면 조용히 제외하지 않고 BLOCKED로 기록한다.
5. 참여 지갑을 일정한 순서로 정렬하여 SDK의 Merkle root와 proof를 생성한다. 자체 hash 알고리즘을 발명하지 않는다.
6. 시즌 공통 정보, snapshot, 기여자 수 및 claim 행을 한 DB 트랜잭션으로 확정한다. 커밋 후부터 재시도는 이 고정 자료를 사용한다.
7. 대상 0명이면 EMPTY로 완료한다. 이미지 보관용 기존 스냅샷은 유지하되 NFT 업로드·컬렉션 생성 비용은 지출하지 않는다.

### 12.3. 이미지와 JSON

- PNG 원본을 다시 렌더링·리사이즈하지 않고 게시한다.
- `asset_name`은 `Cameo ` 접두어와 시즌 제목을 사용하며 선택한 Candy Machine의 UTF-8 byte 제한을 준수한다. 32 bytes를 기준으로 코드포인트 경계에서 제목을 자르고, 잘린 전체 제목은 JSON attribute에 보존한다. `$ID$`와 `$ID+1$`가 치환되지 않도록 이름 생성에서 `$`를 전각 `＄`로 바꾼다.
- JSON 필드는 name, description, image, attributes, properties.files, properties.category로 고정한다.
- description은 시즌 설명이 있으면 사용하고 없으면 `A collaborative canvas completed on Cameo.`를 사용한다.
- attributes는 Season ID(UUID), Season Title(원래 전체 제목), Ended At(UTC ISO 8601), Contributors(확정 인원 정수), Image SHA256을 포함한다.
- properties.files는 PNG URI와 `image/png`, category는 `image`다. 사용자별 주소·식별자·기여 수, 로열티 수취인 및 사용자별 번호는 넣지 않는다.
- JSON 키 순서와 직렬화를 고정하여 동일한 자료로 같은 바이트·해시를 생성한다. 최종 JSON bytes와 해시를 재시도 사이에 유지한다.
- 외부 서비스 계정이 없어도 이 순수 JSON 생성·검증은 자동 테스트할 수 있어야 한다.

### 12.4. 발행 환경 생성과 잠금

1. 서비스 지갑이 컬렉션과 시즌별 Candy Machine·Guard 준비 비용을 낸다. 계정 주소를 거래 전 DB에 기록하고 재시도 때 다른 계정을 무조건 만들지 않는다.
2. Collection에 ImmutableMetadata를 적용한다. 발행된 자산도 이름·URI를 변경할 수 없는지 검증한다. 문서의 `isMutable=false` 설정 하나만으로 요구사항 충족을 가정하지 않는다.
3. Candy Machine은 Hidden Settings에 최종 name·metadata URI를 넣고 `itemsAvailable=eligible_count`로 설정한다. reveal·일련번호·랜덤 아트 기능은 사용하지 않는다.
4. Guard는 Allow List(root)와 Mint Limit(id=0,limit=1)를 사용한다. Sol Payment, Token Payment, Bot Tax, End Date 및 우회 가능한 guard group은 사용하지 않는다.
5. Payer, 민팅 지갑 및 최초 owner는 고정된 참가 지갑으로 같게 한다. 브라우저가 임의의 owner를 지정하는 계약을 만들지 않는다.
6. 잠금 전에는 일반 수령을 열지 않는다. 서비스 준비가 진행 중인 동안 Guard의 민팅을 Start Date로 차단하고, 최종 설정·권한 잠금 거래에서 해당 대기 조건을 제거한다.
7. 최종 설정의 name·URI·root·수량·guard를 읽어 고정 자료와 비교한다. Candy Machine의 mint authority는 Candy Guard로 유지한다.
8. Candy Machine과 Guard의 관리 authority 및 Collection의 관리 authority를 서명 불가능한 주소로 이관하여 서비스가 이후 설정을 변경하지 못하게 한다. Collection의 Candy Machine 발행용 delegate는 유지한다.
9. 잠금 주소는 System Program ID와 고정 seed `cameo-nft-lock-v1`로 도출한 off-curve PDA를 사용한다. 이 주소에 서명하는 자체 프로그램을 만들지 않는다. mint authority와 관리 authority를 혼동하여 Candy Guard의 민팅 기능까지 없애지 않는다.
10. 위 권한 이관의 실제 SDK 호출, Collection delegate 유지, 권한 이관 후 민팅 가능 여부를 단계 0의 Devnet 검증에서 확인한다. 이 검증이 실패하면 요구사항을 낮추거나 운영 키를 유지한 채 완료 처리하지 않는다.
11. 잠금 거래가 finalized이고 모든 설정이 예상값이면 DB READY로 전환한다. chain 준비 완료와 DB 반영 사이 프로세스 종료는 체인 설정 재조회로 복구한다.

관리 권한 잠금은 의도적으로 되돌릴 수 없다. 이후 미수령자가 남아 있는 동안 rent를 회수하거나 명단·콘텐츠를 수정하는 운영 기능을 제공하지 않는다.

## 13. 사용자 민팅 흐름

### 13.1. 상태 조회

- 로그인 사용자는 시즌 NFT 정보를 조회한다. 공개 준비 상태와 사용자별 자격·수령 상태를 함께 반환하되 인증 사용자 외의 claim은 조회하지 않는다.
- 서버가 종료 사유, usage 기여, 고정 지갑 및 실제 claim을 판단한다. 클라이언트의 strokeCount와 minted flag를 근거로 삼지 않는다.
- 정상 종료 이전에는 WAITING_FOR_END, 준비 중에는 PREPARING, 조기 종료·취소는 UNAVAILABLE로 표시한다.

### 13.2. 수령 시도 생성

1. 사용자 세션·Origin·참여 지갑을 검증한다.
2. release가 READY인지 확인하고 claim 행을 잠근다.
3. 이미 CLAIMED면 기존 수령 결과를 반환한다. 활성 attempt가 있으면 그 attempt를 반환한다.
4. 없으면 QUEUED attempt를 만들고 commit한다. HTTP 요청 안에서 체인 확정까지 기다리지 않는다.
5. 워커는 해당 지갑의 MintCounter와 AllowListProof 계정을 확인한다. counter=1이면 과거 발행 복구로 전환한다.
6. AllowListProof가 없으면 proof 등록 거래를 먼저 준비한다. 이미 올바른 root의 proof가 있으면 MINT로 바로 진행한다.

### 13.3. 지갑 서명과 제출

- 최대 두 번의 지갑 승인이 필요할 수 있다. UI에 `참여 자격 등록`과 `NFT 발행` 단계를 구분한다.
- proof 등록과 mint는 별도 거래로 구현하여 100명 명단의 proof까지 포함해도 거래 크기 제한을 넘지 않게 한다. proof가 finalized된 뒤 fresh blockhash로 mint를 준비한다.
- 거래는 서버에서 legacy 형식으로 생성한다. 필요한 instruction이 1232 bytes를 초과하면 전송하지 않고 검증 오류를 기록한다. 임의로 잘라 일부 instruction을 누락하지 않는다. Core 자산의 새 키가 필요한 경우 자산 생성용 서명만 서버가 미리 추가하고 사용자 fee payer 서명은 비워 둔다.
- 부분 서명된 거래, 정확한 message hash, blockhash 및 lastValidBlockHeight를 저장한 뒤 응답한다. 사용자 지갑 비밀키는 서버로 받지 않는다.
- 프론트는 거래의 네트워크와 서명 계정을 확인하고 `solana:signTransaction`을 호출한다. 기능 미지원 지갑은 명확히 안내하며 임의의 signIn 서명으로 대체하지 않는다.
- 서명 후 `transactionId`와 signedTransactionBase64를 서버에 제출한다.
- 서버는 인증 소유권, 저장한 메시지와의 byte 일치, 필요한 모든 서명, fee payer 및 자산 주소를 확인한다. Solana 거래 자체에 별도 network 필드가 있다고 가정하지 않는다. attempt/release의 고정 network와 해당 network RPC에서 받은 blockhash를 기준으로 환경을 검증한다. 임의 거래를 받아 보내주는 일반 RPC proxy를 만들지 않는다.
- signed bytes와 signature를 DB에 저장한 뒤 전송한다. 동일한 거래 제출은 같은 결과를 반환한다.
- 네트워크 전송 timeout이면 같은 signed bytes를 재전송한다. 새 blockhash·새 거래를 곧바로 생성하지 않는다.

### 13.4. 성공과 유실 복구

- 사용자에게 확인 중 상태를 먼저 표시하고 finalized 성공 시 수령 완료로 전환한다.
- RPC의 signature 반환만으로 성공 처리하지 않는다. transaction meta.err=null, 예상 프로그램·컬렉션·민팅 대상·name·URI 및 실제 Core 자산을 확인한다.
- 현재 소유자가 다른 지갑이어도 최초 발행 거래가 참가 지갑에 민팅했으면 수령 완료다. 거래 확인 전에 NFT를 전송했을 가능성을 고려한다.
- 클라이언트가 제출 응답을 못 받아도 서버 워커가 저장된 거래를 계속 확인한다. 다시 로그인하면 DB 상태를 반환한다.
- 서버를 거치지 않고 유효한 거래가 제출된 경우 저장한 asset 주소와 MintCounter로 탐지한다. 필요하면 MintCounter 관련 signature 이력을 조회하여 원래 발행 거래를 확인한다.
- MintCounter는 이미 소비됐으나 거래 이력을 아직 조회할 수 없으면 CLAIMED/RESOLVING으로 표시한다. ‘재발행’ 버튼을 제공하지 않는다.
- finalized 기준 block height가 lastValidBlockHeight를 넘고 과거 signature(이력 검색 포함)·asset·counter에서 성공이 확인되지 않은 경우에만 EXPIRED로 종료하고 새 거래를 준비한다. signature가 confirmed이거나 RPC가 실패하면 계속 확인 중으로 둔다.

### 13.5. 예상 비용

- proof 등록이 필요한 경우 그 계정 생성 비용과 거래 수수료를, mint에는 자산·카운터 생성 및 프로토콜 비용·거래 수수료를 포함한다.
- simulation과 현재 rent/fee 조회를 사용하고 추정 총액·추정 시각을 표시한다. 실제 비용이 달라질 수 있음을 짧게 안내한다.
- 우선순위 수수료가 필요하면 환경 설정 상한 내에서만 사용하고 예상 비용에 포함한다. 사용자에게 보이지 않는 서비스 수수료를 넣지 않는다.
- 여러 단계 중 proof가 성공하고 mint가 실패하면 이미 사용한 proof를 재사용한다. 전체 실패로 간주해 proof 비용을 반복 청구하지 않는다.

## 14. HTTP 계약 초안

기존 전역 응답 envelope와 Origin·cookie 인증 규칙을 유지한다. 아래 타입은 envelope의 `data`다. 공개 오류 message는 영어이며 설명은 Swagger에 한국어로 작성한다. 상세 계약의 구현 후 기준은 decorator와 응답 모델이다.

### 14.1. `GET /seasons/:seasonId/nft`

- 인증 필수. seasonId UUID. 존재하지 않는 시즌은 404.
- 200 응답:

```ts
type SeasonNftView = {
  seasonId: string;
  network: 'devnet' | 'mainnet-beta';
  availability: 'WAITING_FOR_END' | 'PREPARING' | 'READY' | 'EMPTY' | 'UNAVAILABLE';
  reason: 'CANCELLED' | 'FORCE_ENDED' | 'FEATURE_DISABLED' | null;
  name: string | null;
  imageUrl: string | null;
  metadataUri: string | null;
  eligibleCount: number | null;
  claim: {
    eligibility: 'ELIGIBLE' | 'NOT_PARTICIPANT' | 'NO_VALID_STROKE';
    state: 'UNCLAIMED' | 'PROCESSING' | 'CLAIMED';
    walletAddress: string | null;
    activeAttemptId: string | null;
    assetAddress: string | null;
    signature: string | null;
    receiptState: 'NONE' | 'RESOLVING' | 'VERIFIED';
    claimedAt: string | null;
  };
};
```

- 준비 실패의 내부 provider 오류·키·경로는 공개하지 않는다. 일반 사용자는 PREPARING과 재시도 안내를 본다.
- 세션 지갑과 고정 수령 지갑 불일치는 수령 시도에서 검증한다. 조회 결과는 고정 지갑을 안내하는 데 쓴다.

### 14.2. `POST /seasons/:seasonId/nft/claim-attempts`

- 인증 및 Origin 검증 필수. body 없음. 임의 지갑·가격·네트워크·메타데이터 입력을 받지 않는다.
- 새로운 시도는 202 `{ attemptId, state: 'QUEUED' }`.
- 활성 시도 재요청은 200 `{ attemptId, state }`.
- 이미 수령한 경우 200 `{ attemptId: null, state: 'CLAIMED' }`. 중복 클릭을 새 발행으로 처리하지 않는다.

### 14.3. `GET /seasons/:seasonId/nft/claim-attempts/:attemptId`

- 본인 시도만 조회한다. 다른 사용자 또는 다른 시즌의 attempt는 404.
- 200 응답:

```ts
type ClaimAttemptView = {
  attemptId: string;
  state: 'QUEUED' | 'AWAITING_SIGNATURE' | 'SUBMITTING' | 'CONFIRMING'
    | 'SUCCEEDED' | 'EXPIRED' | 'FAILED';
  step: 'ALLOWLIST_PROOF' | 'MINT';
  walletAddress: string;
  network: 'devnet' | 'mainnet-beta';
  transaction: null | {
    transactionId: string;
    serializedTransactionBase64: string;
    lastValidBlockHeight: string;
    estimatedCostLamports: string;
    estimatedAt: string;
  };
  errorCode: string | null;
  retryable: boolean;
};
```

- transaction은 유효한 서명 대기 상태에서만 반환한다. 결과가 끝난 시도의 서명 거래를 반복 노출하지 않는다.

### 14.4. `POST /seasons/:seasonId/nft/claim-attempts/:attemptId/transactions`

- body: `{ transactionId: UUID, signedTransactionBase64: string }`.
- base64 형식, decode 후 Solana 거래 크기 한도, 저장한 거래와 message 일치 및 서명을 검사한다. 예상 외 필드는 기존 validation 정책으로 거절한다.
- 202 `{ attemptId, state: 'SUBMITTING', signature }`. 같은 signed bytes와 signature의 재제출은 200으로 현재 기존 상태를 반환한다.
- 체인 확정까지 HTTP 연결을 유지하지 않는다. 기존 프론트 10초 timeout 안에서 접수 처리를 끝낸다.

### 14.5. `GET /seasons/participated`

- 인증 필수. 정적 route가 `:seasonId`와 충돌하지 않도록 등록한다.
- query: `limit` 정수 1..50, 기본 20; `offset` 정수 >=0, 기본 0.
- 로그인 사용자 기준 season_participants를 조회하며 개설자의 자동 참가도 포함한다. 종료 시즌을 제외하지 않는다.
- 정렬: joined_at DESC, season_id DESC. 응답 `{ items, total, limit, offset }`.
- item 타입은 다음과 같다. lifecycleStatus의 값은 기존 시즌 응답 enum을 그대로 재사용한다.

```ts
type ParticipatedSeasonItem = {
  seasonId: string;
  title: string;
  lifecycleStatus: 'scheduled' | 'active' | 'ended' | 'cancelled';
  startsAt: string;
  endsAt: string;
  joinedAt: string;
  ownStrokeCount: number;
  finalImageUrl: string | null;
  nft: Pick<SeasonNftView, 'network' | 'availability' | 'reason' | 'claim'>;
};
```
- ownStrokeCount는 usage 행 개수다. chunk 수나 좌표 점 개수를 획 수로 사용하지 않는다.
- 목록에서 시즌마다 외부 RPC를 호출하지 않는다. DB의 준비·수령 상태를 JOIN하여 반환한다.

### 14.6. 오류 계약

| HTTP | code | message | 조건 |
| --- | --- | --- | --- |
| 401 | 기존 인증 오류 코드 | 기존 영어 메시지 | 세션 없음·만료·구버전 지갑 없는 세션 |
| 403 | NFT_NOT_ELIGIBLE | You are not eligible to claim this season NFT. | 미참가 또는 유효 획 없음 |
| 403 | NFT_WALLET_MISMATCH | Use the wallet that participated in this season. | 고정 지갑과 인증·서명 지갑 불일치 |
| 404 | NFT_CLAIM_ATTEMPT_NOT_FOUND | Claim attempt not found. | 존재하지 않거나 타인 소유의 시도 |
| 409 | NFT_SEASON_UNAVAILABLE | This season is not eligible for NFT claims. | 취소·조기 종료 |
| 409 | NFT_NOT_READY | The season NFT is not ready to claim. | 정상 종료 전·준비 미완료·EMPTY |
| 409 | NFT_TRANSACTION_EXPIRED | The transaction has expired. Please try again. | 만료를 체인 기준으로 확인 |
| 400 | NFT_TRANSACTION_INVALID | The signed transaction does not match the prepared transaction. | 메시지·서명·길이·payer 불일치 |
| 503 | NFT_SERVICE_UNAVAILABLE | NFT claims are temporarily unavailable. | 기능 비활성화·필수 설정 장애 |

- 잔액 부족은 비동기 시도에 `NFT_INSUFFICIENT_FUNDS`와 retryable=true를 기록한다. claim 권한은 유지한다.
- RPC 429는 내부 재시도 대상으로 처리한다. 모든 사용자에게 같은 429를 그대로 전파하여 클라이언트 재시도 폭주를 만들지 않는다.

## 15. 워커, 처리량 및 복구

- 워커는 Nest lifecycle에서 시작·종료한다. 사용자별 요청 정보를 singleton 필드에 보관하지 않는다.
- PostgreSQL 전용 connection의 advisory lock으로 환경별 NFT 워커 leader 한 개를 선출한다. 연결이 끊기면 더 이상 외부 작업을 시작하지 않고 다시 lock을 얻는다.
- API는 작업 상태를 DB에 접수한다. 외부 RPC는 leader의 공통 scheduler를 통과한다. v1 단일 프로세스의 모든 SDK 호출과 재시도가 같은 무료 RPC 한도를 공유하게 한다.
- 기본 읽기 한도는 초당 5회, 전송은 1.2초당 최대 1회이며 읽기와 전송의 합계도 초당 5회로 제한한다. 운영 환경변수로 낮추거나 변경할 수 있게 한다.
- 우선순위는 서명된 사용자 거래 전송, 사용자 거래 확인, 사용자용 거래 준비, 시즌 공통 준비 순서다. 진행 중 준비 작업을 굶기지 않도록 연속 사용자 작업 10개마다 준비 작업 1개를 처리한다.
- 미확정 거래는 5초 간격에서 시작해 15초까지 간격을 늘린다. pending signature를 가능한 경우 batch 조회한다.
- 일시 실패 재시도는 5초, 15초, 60초, 5분, 이후 최대 15분 간격에 jitter를 적용한다. Retry-After가 있으면 존중한다.
- 잘못된 키·잘못된 계정 설정·해시 불일치·권한 잠금 불일치는 BLOCKED로 기록한다. 유료 반복 작업을 무한 실행하지 않는다.
- 서비스 지갑 잔액 부족은 자격을 지우지 않고 준비를 대기시킨다. 잔액 보충 후 재시도할 수 있도록 진단과 재시도 CLI를 제공한다.
- 복구 CLI는 release/attempt ID만 받으며 원래 고정 자료를 유지한다. 명단·URI 수정 기능을 겸하지 않는다.
- 로그에는 releaseId, seasonId, attemptId, transactionId, stage, duration, retryCount 및 오류 코드를 기록한다. cookie·비밀키·signed bytes·RPC URL query key는 기록하지 않는다.
- 최소 관측 값: 준비 지연, BLOCKED 건수, 대기 시도 수, RPC 429 수, 전송·확정 지연, 서비스 지갑 잔액 경고, 이미지 해시 불일치.

## 16. 프론트 구현 계약

### 16.1. 공통 수령 기능

- `src/features/season-nft-claim/api/`에 status·attempt·submit 요청 및 query key를 둔다.
- status query key는 세션 사용자 ID와 seasonId를 포함하며 attempt key에는 network와 attemptId도 포함한다. 서버 network 변경 시 해당 사용자 NFT cache를 폐기한다. 로그아웃·계정 변경 시 이전 시도의 로컬 서명 상태를 폐기한다.
- `model/`에서 단일 수령 상태 흐름을 관리하고 `ui/SeasonNftClaimCard.tsx`를 시즌 상세·workspace·프로필에서 재사용한다.
- 기존 Wallet Standard 연결 코드를 필요한 범위에서 재사용하거나 `src/shared/lib/solana-wallet/`로 공유한다. 전체 헤더 인증 기능을 새로 작성하지 않는다.
- 서버 고정 지갑과 선택한 wallet account가 같고 해당 account가 목표 chain 및 signTransaction을 지원해야 서명을 허용한다.
- 서명 팝업은 사용자의 클릭으로만 연다. polling 결과만으로 반복 팝업을 열지 않는다.

### 16.2. 사용자 표시

| 서버 상태 | 표시·행동 |
| --- | --- |
| 정상 종료 전 | 시즌 종료 후 수령 가능 안내 |
| 취소·조기 종료 | NFT 수령 대상 시즌이 아니라는 안내 |
| 준비 중 또는 BLOCKED의 공개 표현 | 최종 NFT 준비 중. 민팅 버튼 비활성화 |
| 유효 획 없음 | 기여한 참여자만 수령 가능 안내 |
| READY + 미수령 | 이미지·이름·예상 비용 확인 후 ‘NFT 받기’ |
| QUEUED | 거래 준비 중 |
| proof 서명 대기 | 참여 자격 등록 및 해당 단계 비용 안내 |
| mint 서명 대기 | NFT 발행 및 해당 단계 비용 안내 |
| 확인 중 | 네트워크 확인 중. 중복 발행 버튼 비활성화 |
| 지갑 서명 취소 | 취소 안내와 다시 시도 버튼. 수령 권한 유지 |
| 잔액 부족 | 필요한 예상 SOL과 잔액 보충 안내 |
| 만료·확정 실패 | 원인에 맞는 재시도 버튼 |
| CLAIMED + RESOLVING | 수령 완료, 거래 정보 확인 중 |
| CLAIMED + VERIFIED | 수령 완료, NFT·거래 링크 |

- 준비 상태는 활성 탭에서 30초 polling한다. 활성 attempt는 3초 polling하되 네트워크 오류 시 최대 15초로 늘린다. hidden tab은 polling을 멈추고 복귀 시 갱신한다.
- 서버가 체인 확인을 담당하므로 탭을 닫아도 제출된 거래 처리는 계속된다.
- 성공 시 해당 시즌 status, 상세 화면 및 프로필 참여 목록 query를 무효화한다.
- UI는 기존 디자인·번역·접근성 패턴을 따른다. 키보드로 버튼과 dialog에 접근할 수 있고 진행 상태를 텍스트로 표시한다.

## 17. 설정 계약과 운영 인계 기본값

아래는 신규 설정 이름의 설계안이다. 기존 설정과 의미가 같으면 기존 키를 재사용하고 중복 키를 만들지 않는다.

| 설정 | 위치 | 기본·필수 조건 |
| --- | --- | --- |
| SEASON_NFT_ENABLED | 서버 | 기본 false. 필수 준비 후 true |
| SOLANA_NETWORK | 서버 | devnet 또는 mainnet-beta. 활성화 시 필수 |
| SOLANA_RPC_URL | 서버 비밀 | 활성화 시 필수. 로그 노출 금지 |
| SOLANA_SERVICE_KEYPAIR_PATH | 서버 비밀 파일 경로 | 환경별 전용 키. 읽기 전용 secret mount 지원 |
| NFT_STORAGE_UPLOAD_URL | 서버 | 환경별 Turbo upload endpoint |
| NFT_STORAGE_PAYMENT_URL | 서버 | 환경별 Turbo payment endpoint |
| NFT_STORAGE_GATEWAY_URL | 서버 | 불변 content ID의 공개 조회용 base URL |
| NFT_UPLOAD_WORK_DIR | 서버 | 절대 경로의 지속 저장소. signed upload item 복구용 |
| NFT_PREPARATION_KEY_DIR | 서버 비밀 디렉터리 | 준비 중 임시 keypair를 보관하는 지속 경로. public static과 분리 |
| NFT_RPC_READ_RPS | 서버 | 기본 5 |
| NFT_RPC_SEND_INTERVAL_MS | 서버 | 기본 1200 |
| NFT_PRIORITY_FEE_MAX_LAMPORTS | 서버 | 기본 0. 변경 시 비용 추정에 반영 |
| 기존 CANVAS_SNAPSHOT_* | 서버 | NFT 활성화 시 snapshot 활성화 및 영구 저장 경로 필수 |
| 기존 API base URL | 프론트 | backend 주소. RPC 비밀키는 프론트에 넣지 않음 |

- 클라이언트의 목표 network는 NFT 응답으로 받아 서버와 일치시킨다. 프론트 별도 하드코딩 network가 서버와 달라도 조용히 진행하지 않는다.
- 활성화 시 설정 검증에 실패하면 NFT 작업을 시작하지 않고 명확한 startup 오류를 낸다. 로컬 filesystem 스냅샷 경로가 일회성 컨테이너 파일시스템이면 운영 준비 완료로 판정하지 않는다.
- 새 worker를 실행할 Node 프로세스가 지속적으로 살아 있어야 한다. 배포 플랫폼이 짧은 요청 단위 실행만 제공하면 별도 지속 프로세스로 같은 worker를 실행해야 한다.
- 무료 RPC 선택은 무제한 호출을 뜻하지 않는다. 동료가 해당 계정을 다른 서비스와 공유하면 한도를 더 낮추거나 계정을 분리한다.

## 18. 구현 단계와 단계별 완료 조건

아래 순서로 구현하며 각 단계의 검사 결과를 인계 기록에 남긴다. 사용자에게 이미 확정한 제품 정책을 다시 묻지 않는다. SDK 또는 실제 환경이 필수 조건을 지원하지 않는 경우에는 검증 실패를 보고하고 요구사항을 임의로 낮추지 않는다.

### 단계 0. SDK와 권한 잠금 검증

- 책임: 외부 라이브러리 호환성과 필수 온체인 조건 확인.
- 작업: backend Node/TS 환경에서 Umi, mpl-core, mpl-core-candy-machine, Turbo SDK의 호환 버전을 확인하고 정확한 버전과 lockfile을 고정한다. 공식 문서 예시와 설치 SDK export를 대조한다.
- 준비할 검증: 2명 allowlist, 한 명의 외부 지갑, 동일 metadata, mintLimit=1, 컬렉션 불변성 및 관리 권한 잠금.
- 통과 조건: 권한 잠금 후 허용 지갑은 mint 가능, 비허용 지갑과 2회 민팅은 실패, 관리자 name·URI·root·발행량 변경은 실패, 자산 전송은 성공.
- 같은 Collection의 후속 자산도 원래 name·URI를 쓰는지 확인한다. `isMutable=false`만 확인하고 종료하지 않는다.
- Devnet 자금·키가 없는 상태에서는 컴파일·로컬 테스트 결과만 보고하고 온체인 검증을 미완료로 남긴다. 동료가 실행할 동일 검증 명령을 제공한다.
- 다음 단계 입력: 고정된 SDK 버전, 검증 스크립트 및 권한 잠금 동작의 증거.

### 단계 1. 세션 지갑과 참가 지갑 고정

- 변경: auth session repository/authenticator/login UseCase, seasons create/join UseCase 및 participant repository, 관련 HTTP 오류 mapping.
- SQL: 세션 wallet FK 및 참가 지갑 컬럼·제약. 기존 개발 데이터 초기화 스크립트와 재로그인 안내 작성.
- 테스트: 다른 사용자 지갑 FK 거절, 개설자 자동 참가 지갑 저장, 재참가 불변, 다른 지갑 참가 거절, 구세션 401.
- 완료 조건: 새로운 참가자의 지갑을 이후 목록 순서나 로그인 변경에 의존하지 않고 조회할 수 있다.

### 단계 2. NFT 데이터 모델과 모듈

- 신규: `src/modules/season-nfts/season-nfts.module.ts`와 `resources/season-nft/`의 상태·repository, `resources/claim/`의 수령·시도 repository, SQL migration.
- 신규 공개 capability: `src/modules/canvas/resources/canvas-snapshot/final-canvas-snapshot-reader.ts`를 CanvasModule에서 export.
- repository는 명확한 조건부 update와 UNIQUE를 사용한다. 외부 I/O를 DB transaction 안에서 수행하지 않는다.
- 테스트: 중복 release/claim/활성 attempt 거절, READY·EMPTY 필수값 제약, 다른 canvas 스냅샷 연결 방지, snapshot 해시 불일치.
- 완료 조건: 모든 상태를 DB에서 복원할 수 있고 process 메모리만으로 진행 여부를 판단하지 않는다.

### 단계 3. 종료 감지·자격 고정·파일 게시

- 신규: `features/prepare-season-nft/prepare-season-nft.use-case.ts`, 준비 runner, `resources/nft-media/`의 JSON 생성 및 Turbo 게시 코드.
- 최종 스냅샷을 기다리고 정상 종료 재검증 후 명단을 고정한다. 0명은 EMPTY로 처리한다.
- 파일 게시 전후 해시를 비교하고 signed upload item을 재사용한다.
- 테스트: 조기 종료 후 원래 종료 시각 경과, 유효 획 없는 참가자, 미완료 chunk의 유효 usage, 0명, 게시 timeout 후 재조회 복구.
- 완료 조건: 중단·재시작해도 같은 snapshot·명단·이미지·JSON이 유지된다.

### 단계 4. 시즌 발행 환경 자동 준비

- 신규: `resources/solana-nft/`의 SDK provider, 트랜잭션 영속화 및 공통 RPC scheduler.
- Collection·Machine·Guard를 생성하고 설정 검증·잠금·finalized 확인 후 READY로 전환한다.
- 서비스 작업도 저장 후 전송하며 이미 생성된 계정은 재사용한다.
- 테스트: 각 단계 직후 crash, 서비스 잔액 부족, RPC 429, 해시 및 온체인 설정 불일치, 중복 runner.
- 완료 조건: 정상 종료부터 READY까지 운영자 승인 없이 진행되고 잘못된 설정은 수령을 열지 않는다.

### 단계 5. 조회 및 프로필 API

- 신규: `features/get-season-nft/` controller/UseCase/응답 모델.
- 신규: SeasonsModule의 `features/list-participated-seasons/` controller/UseCase/query.
- 필요한 상태는 DB JOIN으로 조회하고 목록마다 RPC를 호출하지 않는다.
- Swagger에 성공 모델·nullable·오류·인증을 정확히 정의한다. `docs/api/`에는 화면 연동 흐름만 적는다.
- 테스트: 사용자별 데이터 분리, 개설자 포함, 종료 시즌 포함, 정적 route 충돌 없음, 0·50 경계와 offset, 취소·조기 종료 상태.
- 완료 조건: 샘플 profile 데이터 없이 해당 사용자의 참여·수령 상태를 실제 API로 조회할 수 있다.

### 단계 6. 사용자 민팅과 거래 복구

- 신규: `features/create-claim-attempt/`, `features/get-claim-attempt/`, `features/submit-claim-transaction/`, `features/reconcile-nft-transactions/`.
- proof와 mint 단계, 부분 서명 거래, byte 단위 message 확인, finalized 검증, counter 기반 중복 방지를 구현한다.
- 테스트: 다중 탭, 변조 거래, 타인 attempt, 서명 취소, proof만 성공, blockhash 만료, 전송 응답 유실, DB 갱신 실패, 전송·소각 후 재수령 차단.
- 완료 조건: 성공한 발행 최대 1개를 지키면서 실패와 미확정 상태를 구분하고 안전하게 다시 진행한다.

### 단계 7. 프론트 수령 및 프로필 실제 연결

- 신규 공통 feature와 서버 API query/mutation, Wallet Standard 거래 서명을 구현한다.
- 변경: SeasonDetailDialog, SeasonWorkspacePanel, JoinedCanvases 및 해당 profile API/query. MySeasons의 잘못된 NFT 버튼·minted placeholder만 제거하고 기존 샘플을 명시한다. 만든 시즌도 실제 JoinedCanvases에서 수령한다.
- 지갑 서명 단계별 비용·취소·진행 상태, 성공 링크 및 새로고침 복구를 연결한다.
- 테스트: 16절 상태표, 사용자 전환, 화면 사이 상태 동기화, 키보드·dialog focus, 모바일 레이아웃, 샘플 minted값 미사용.
- 완료 조건: 사용자가 시즌 상세·캔버스·프로필 어느 곳에서든 같은 NFT를 한 번만 수령한다.

### 단계 8. 운영 도구·문서·통합 검증

- 신규 스크립트: 개발 데이터 초기화, 설정 사전 검사, BLOCKED release 재시도 및 NFT 통합 검증. 실제 명령을 package scripts로 제공한다.
- 신규 인계 문서: `docs/deployment/season-canvas-nft.md`. `.env.example`에는 설명과 placeholder만 추가한다.
- backend: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:realtime` 및 신규 NFT 테스트 명령.
- frontend: `npm run test`, `npm run lint`, `npm run format:check`, `npm run build`.
- Devnet E2E: 2명 이상 참여, 정상 종료, 두 사용자 민팅, 무자격·중복 차단, 재시작 복구, 이름·URI 불변 및 전송 검증.
- 완료 조건: 실제 수행한 결과와 외부 계정·자금 부재로 동료가 수행할 결과를 구분한 인계 자료를 제공한다.

### 단계 9. 동료 배포 후 Mainnet 인수

- 담당: 사용자의 GitHub 업로드 후 동료의 배포 환경에서 실행.
- 7.6절 순서로 DB·환경 설정·서비스 자금·영구 저장·앱을 준비한다.
- 소규모 검증 시즌을 실제 최소 기간 규칙(현재 1시간 이상)에 맞춰 생성하고 정상 종료시킨다. 테스트 편의를 위해 운영 종료 규칙을 낮추거나 조기 종료로 우회하지 않는다.
- 실제 UI에서 참가 지갑이 비용을 내고 NFT를 받는지 확인한다. 고정된 이미지·JSON·자산·거래를 확인하고 중복 클릭을 검증한다.
- 완료 조건: Mainnet 자산 주소와 성공 거래가 확인되고 실제 수령 결과가 시즌 화면과 프로필에 표시된다.

## 19. 최종 인수 체크리스트

- [ ] REQ-001~024를 모두 충족한다.
- [ ] 일반 캔버스, 취소 시즌 및 조기 종료 시즌에 NFT 발행 경로가 열리지 않는다.
- [ ] 정상 종료의 마지막 승인된 획이 포함된 최종 PNG를 사용한다.
- [ ] 기여자 0명은 비용을 쓰지 않고 EMPTY로 완료한다.
- [ ] 최대 100명 중 유효 기여자만 고정한 참여 지갑으로 수령한다.
- [ ] 여러 탭·재시도·전송·소각 후에도 성공한 민팅은 사용자당 1회다.
- [ ] 서명한 거래가 변조되면 서버가 전송하지 않는다.
- [ ] RPC 응답 유실과 프로세스 재시작 후 체인 결과를 복구한다.
- [ ] 이미 발행한 자산과 미래 수령자의 콘텐츠 모두 잠겨 있다.
- [ ] 무기한 수령을 위해 발행 설정과 이미지·JSON을 유지한다.
- [ ] 개인 정보·로열티·별도 발행 가격이 NFT 메타데이터나 거래에 추가되지 않는다.
- [ ] 시즌 화면과 실제 프로필 목록의 수령 상태가 일치한다.
- [ ] 외부 서비스 키와 지갑 비밀값이 GitHub·프론트 번들·로그에 없다.
- [ ] 무료 RPC 한도를 공유하는 모든 서버 호출에 처리량 제한이 적용된다.
- [ ] 배포 인계와 실제 Mainnet 인수의 완료 상태를 구분한다.

## 20. 기술 검증 근거와 한계

- Core Candy Machine 공식 SDK 문서와 공개 소스에서 AllowList/MintLimit, HiddenSettings, 관리 authority 변경 흐름을 확인했다. 설치 SDK와 실제 배포된 프로그램에서의 호환성은 단계 0에서 검증한다.
- 확인한 `mint_asset.rs`는 Collection delegate와 name·URI를 이용해 Core 자산을 생성한다. `is_mutable` 필드의 존재만으로 생성된 NFT의 불변성이 보장된다고 추정하지 않는다. Collection의 ImmutableMetadata와 권한 잠금을 실제로 검사한다.
- https://raw.githubusercontent.com/metaplex-foundation/mpl-core-candy-machine/main/programs/candy-machine-core/program/src/instructions/mint_asset.rs
- https://raw.githubusercontent.com/metaplex-foundation/mpl-core-candy-machine/main/programs/candy-machine-core/program/src/instructions/set_authority.rs
- https://raw.githubusercontent.com/metaplex-foundation/mpl-core-candy-machine/main/programs/candy-machine-core/program/src/state/candy_machine_data.rs
- 본 스펙 작성 중 로컬 앱 코드나 DB 데이터는 변경하지 않았고, 계정 가입·키 생성·결제·실제 민팅은 수행하지 않았다. 이 문서는 실행 검증 보고서가 아니다.

## 21. 작업별 실행 문서

전체 구현 단계는 [작업별 실행 인덱스](../plans/2026-10-09-season-canvas-nft.md)에서 시작한다. 12개 작업 문서와 공통 계약으로 분리했으며, 각 작업의 파일 소유권·입출력·구현 체크리스트·검증 명령·완료 조건을 정의한다. 이 문서의 REQ-001~024와 INV-01~10은 계속 제품 정책의 기준이다. 실행 계획에 추가한 구현 세부는 [공통 계약](../plans/2026-10-09-season-canvas-nft/shared-contracts.md)의 해당 절을 따른다.

작업 문서의 체크박스는 아직 실행하지 않은 계획이다. 실제 SDK 검증과 Mainnet 발행을 완료한 것으로 해석하지 않는다.

### 21.1. 구현 결정 revision 2

[추가 질문 없이 적용할 구현 결정 계약](../plans/2026-10-09-season-canvas-nft/implementation-contract.md)을 작업 문서와 함께 적용한다. 이 계약은 REQ-001~024를 바꾸지 않고 다음 기술 공백을 확정한다.

- transaction RECONCILED 상태와 성공 효과 복구, 단일 진행·완료 operation UNIQUE.
- 공개 API의 우선순위·200/202 구분·기존 인증/HTTP429 재사용·새 상태 오류.
- last_chunk_sequence 기준 최종 이미지, LEFT JOIN 누락 자격 감지.
- 영구 Arweave URI, 정확한 JSON bytes, 업로드 파일 복구 규칙.
- 공유 RPC 총량·backoff·timeout·leader 종료 기준과 quote 구성요소.
- schema 추가 컬럼·snapshot 복합FK·frozen값 보호와 frontend network별 cache.
- 실제 외부 검증을 대신하지 않는 명확한 SDK 선택·실패·인계 절차.

원본의 간략 기술 개요와 위 계약의 상세 수치가 겹치면 revision 2를 적용한다. 제품 정책 변경을 숨기거나 미검증 외부 결과를 PASS로 처리해서는 안 된다.

### 21.2. 구현 기준과 범위

2026-10-10 기준 backend main `ca0554b`, frontend main `bd58aca`를 대상으로 한다. [09 작업](../plans/2026-10-09-season-canvas-nft/09-frontend-claim.md)의 이미지 표시·profile summary·공개 import·번역 계약을 적용한다. 00의 외부 SDK·Devnet 검증 조건은 유지한다.

[구현 결정 계약](../plans/2026-10-09-season-canvas-nft/implementation-contract.md) 14절의 복구 receipt 독립 스캔, 과거 proof 재제출 응답 union, 초기 QUEUED step, 업로드 lane 분리, 단일 replica 배포 범위, 게이트 분리, 프로필 범위·상태·지갑 표시, 운영 CLI를 적용한다. MySeasons 전체 실데이터 전환·다중 호스트 자동 failover는 필수 범위에서 제외하며 REQ-001~024는 유지한다.
