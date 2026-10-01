# 로그인 챌린지 발급 구현 계획

> 작업자는 `superpowers:executing-plans`에 따라 이 계획을 순서대로 실행한다. 사용자가 챌린지 API 구현을 요청했으므로 현재 세션에서 구현과 검증까지 진행한다.

**목표:** `POST /api/auth/challenges`로 서버가 생성한 SIWS 입력과 브라우저 연결 쿠키를 발급하고 PostgreSQL에 저장한다.

**구조:** `AuthModule`에 챌린지 발급 컨트롤러와 유스케이스를 등록한다. 챌린지 저장소는 기존 전역 DB 풀과 불투명 트랜잭션 문맥을 사용한다. HTTP 계층이 쿠키와 공통 응답을 처리한다.

**기술:** NestJS 12, TypeScript 7, Node.js 24의 암호화·테스트 기능, 기존 `pg`.

**스펙:** [챌린지 API](../../api/auth/challenges.md), [공통 설계](../specs/2026-10-01-web3-auth-design.md).

## 공통 제약

- 이번 구현 범위는 챌린지 발급이며 로그인·사용자 조회·로그아웃은 후속 작업이다.
- 난수 nonce는 32바이트의 소문자 16진수 64자다. 브라우저 연결값은 난수 32바이트의 패딩 없는 Base64url 43자이며 SHA-256 해시만 저장한다.
- 만료는 DB 발급 시각에서 정확히 5분 뒤다. 서버의 허용된 요청 출처로 `domain`과 `uri`를 구성한다.
- 운영은 HTTPS와 `__Host-cameo_auth_binding`, 개발은 `cameo_auth_binding`을 사용한다. HttpOnly, SameSite=Lax, Path=/, Domain 생략, 수명 300초다.
- 정의되지 않은 쿼리는 무시하고, 본문은 허용 필드만 남겨 검증한다. 챌린지 API는 본문·쿼리를 업무 입력으로 사용하지 않는다.
- 한국어 문서와 주요 함수의 목적·처리 단계 주석을 작성한다. 지갑 SDK와 별도 테스트 패키지는 추가하지 않는다.

## 검토 중점

- 누락·null·비허용·유사 접두사 Origin은 403이며 DB와 쿠키를 변경하지 않는다.
- 길이만 맞는 비정규 Base64url 쿠키와 중복 쿠키는 새 난수로 교체한다.
- 저장·커밋 실패는 500이며 신규 쿠키를 발급하지 않고 챌린지를 남기지 않는다.
- 요청 본문과 쿼리의 공격자 지정 nonce·domain은 발급 입력을 바꾸지 않는다.
- 잘못된 JSON과 요청 제한 오류에도 캐시 금지와 기존 공개 오류 형식을 유지한다.

## 작업 1: 발급 API와 실행 검증

**파일:**

- 생성: `src/modules/auth/auth.module.ts`, `src/modules/auth/auth-http.ts`
- 생성: `src/modules/auth/create-challenge/create-challenge.controller.ts`, `src/modules/auth/create-challenge/create-challenge.use-case.ts`
- 생성: `src/modules/auth/challenge/challenge.ts`, `src/modules/auth/challenge/challenge.repository.ts`
- 생성: `db/migrations/2026-10-01-01-auth-challenges.sql`, `test/auth-challenges.e2e.test.cjs`
- 수정: `src/app.module.ts`, `src/app.factory.ts`, `src/config/cors.config.ts`, `src/http/validation-options.ts`, `src/business-error.ts`, `src/http/errors/http-exception.filter.ts`
- 수정: `package.json`, `.env.example`, `README.md`, `docs/CONVENTION.md`, 관련 API 문서와 공통 설계의 구현 상태

**인터페이스:**

- `CreateChallengeUseCase.execute(origin: string | undefined, browserBinding?: string): Promise<CreateChallengeResult>`는 `challengeId`, `signInInput`, 쿠키로만 전달할 `browserBinding`을 반환한다.
- `ChallengeRepository.getIssueTime(transaction: TransactionContext): Promise<Date>`는 밀리초 정밀도의 DB 현재 시각을 반환한다.
- `ChallengeRepository.create(challenge: NewChallenge, transaction: TransactionContext): Promise<void>`는 같은 트랜잭션에 챌린지를 저장한다.
- `createAuthCacheControlMiddleware(apiPrefix: string): RequestHandler`는 인증 경로의 초기 응답과 오류에도 `Cache-Control: no-store`를 지정한다.

- [x] Node 기본 테스트 실행기를 연결하고, 실제 DB의 임시 스키마에서 HTTP 계약 테스트를 작성한다. 정상 발급·입력 무시·쿠키 재사용/교체·출처 거절·운영 쿠키·CORS·DB 실패·JSON 파싱·요청 제한·공통 본문 필터를 포함한다.
- [x] `npm test`를 실행해 발급 API 부재에 따른 404를 확인한다.
- [x] 위 인터페이스와 스펙대로 구현하고, DB 기준 SQL을 추가한다. CORS는 정확한 프론트 Origin과 credentials=true를 사용한다.
- [x] `npm test`를 실행해 전체 계약 검증을 통과시킨다. 테스트가 만든 스키마만 정리한다.
- [x] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`를 수행한다.
- [x] 현재 제공 API와 설정·DB 실행 절차를 문서에 반영하고 최종 코드 검토를 받는다.

## 실행 기록

- 구현 당시 이 폴더는 Git 저장소가 아니었으므로 worktree·커밋·커밋 범위 검토는 적용하지 않았다. 기존 파일의 내용과 새 파일 목록을 기준으로 검토한다.
- 실제 데이터 보호를 위해 DB 통합 테스트는 난수 이름의 임시 스키마에만 쓰고 정리한다.

- RED: API 부재로 404와 추가 본문 필드의 기존 400을 확인했다.
- GREEN: `npm test` 전체 20개 통과. 실제 기준 SQL을 임시 스키마에 적용하고 재적용 시 기존 챌린지 보존도 확인했다.
- 정적 검사: typecheck, lint, format:check, build 모두 통과했다.
- 최종 읽기 전용 리뷰: 차단 결함 없음. 브라우저의 localhost·127.0.0.1 혼용을 피하도록 로컬 API 주소 안내를 보완했다.
- 후속 서명 검증·로그인·세션 API, 만료 행 정리, 분산 요청 제한은 이번 구현 범위 밖이다. 챌린지 저장의 원자성은 PostgreSQL 트랜잭션에 한정되며 커밋 뒤 HTTP 응답 유실은 되돌리지 않는다.
