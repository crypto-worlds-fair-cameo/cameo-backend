# [AGENTS.md](http://AGENTS.md)

이 문서는 프로젝트의 작업 규칙과 agent 역할을 정의합니다.

## Project Overview

- 제한된 획 수 규칙으로 모두가 함께 완성하는 실시간 협업 캔버스 cameo의 백엔드 서버

## Basic Workflow

1. **범위 파악:** 요청이 구현·검토·계획 중 어디에 해당하는지와 작업 대상을 확인하고, 기존 구현·설정 및 관련 문서를 살핍니다.
2. **스킬 선택:** 작업에 필요한 스킬의 `SKILL.md`를 읽고 적용합니다. 코드 작성·수정 시에는 `comment-code-intent`를 적용해 변경한 주요 함수와 핵심 흐름의 주석을 함께 작성·갱신합니다. 자명한 코드에는 주석을 강제하지 않습니다.
3. **최소 변경:** 요청을 완성하는 데 필요한 범위만 변경합니다. 관련 없는 코드나 변경 범위 밖의 주석은 정리하지 않습니다.
4. **API 문서:** API 명세는 Swagger decorator와 HTTP 응답 모델로 관리합니다. 외부 계약이 바뀌거나 문서 오류가 확인된 경우 관련 API만 수정합니다. `docs/api/`의 Markdown에는 사용 흐름과 클라이언트 예제만 작성하며, 필드 명세·오류 목록·내부 처리 과정·작업 이력을 중복 추가하지 않습니다.
5. **API 언어:** 오류 코드의 `message`는 영어로 작성하고, 응답 예시는 실제 영어 메시지를 사용합니다. Swagger 도메인·태그 이름은 영어를 기본으로 사용합니다. API 설명과 오류 `description`은 한국어를 기본으로 하되 영어도 허용합니다.

## Agent Responsibilities

### Core Agents

- `code-mapper`
구현 전에 코드 구조와 영향 범위를 먼저 파악해야 할 때 사용합니다. 코드를 수정하지 않습니다.
- `task-distributor`
큰 작업을 하위 작업으로 나누고 ownership을 분리해 병렬 진행해야 할 때 사용합니다.
- `frontend-developer`
프론트 UI와 클라이언트 로직 구현이 필요할 때 사용합니다.
- `backend-developer`
백엔드 API와 서버 비즈니스 로직 구현이 필요할 때 사용합니다.
- `code-reviewer`
correctness뿐 아니라 유지보수성, 구현 품질, 위험한 선택까지 넓게 리뷰해야 할 때 사용합니다.
- `architect-reviewer`
모듈 경계, 결합도, 장기 유지보수성, 설계 일관성을 구조 관점에서 점검해야 할 때 사용합니다.

### Specialized Agents

- `product-manager`
무엇을 지금 만들고 무엇을 미룰지, 범위와 acceptance criteria를 먼저 정리해야 할 때 사용합니다.
- `project-manager`
여러 작업 흐름의 의존성, 단계, 리스크, 전달 순서를 관리해야 할 때 사용합니다.
- `ui-designer`
구현 전에 구체적인 UI 구조, 상호작용, 상태 표현을 정리해야 할 때 사용합니다. 코드를 직접 수정하지 않습니다.
- `api-designer`
API 계약, request/response schema, 호환성, 버전 전략을 구현 전에 정리해야 할 때 사용합니다.
- `postgres-pro`
PostgreSQL 스키마, 쿼리 성능, 인덱스, 락, 트랜잭션, 마이그레이션을 깊게 검토해야 할 때 사용합니다.
- `seo-specialist`
crawlability, metadata, canonical, rendering, 정보 구조 등 기술 SEO 관점 검토가 필요할 때 사용합니다.
