# Phantom Web3 로그인 설계

- 설계 기준일: 2026-10-01
- 상태: 대화에서 합의한 설계. 챌린지 발급 API와 공통 입력·CORS·DB 설정을 구현했다. 로그인·현재 사용자 조회·로그아웃은 구현 예정이다.
- 목적: cameo 사용자가 PC의 Phantom 지갑으로 로그인하고, 별도 가입 없이 서비스 계정을 사용한다.

## 범위와 API 문서

첫 버전은 PC Phantom 확장 프로그램과 Solana SIWS 서명을 지원한다. 프론트는 자체 로그인 버튼에서 지갑 제공 인터페이스 또는 Wallet Standard의 `signIn`을 호출한다. Phantom 앱 내 브라우저는 호환성을 보조 확인하며, 일반 모바일 브라우저의 앱 전환 흐름은 후속 범위다.

| API | 성공 상태 | 구현 상태 | 개별 스펙 |
| --- | --- | --- | --- |
| `POST /api/auth/challenges` | 201 | 구현 완료 | [챌린지 발급](../../api/auth/challenges.md) |
| `POST /api/auth/sign-in` | 200 | 구현 예정 | [로그인](../../api/auth/sign-in.md) |
| `GET /api/auth/me` | 200 | 구현 예정 | [현재 사용자](../../api/auth/me.md) |
| `POST /api/auth/logout` | 200 | 구현 예정 | [로그아웃](../../api/auth/logout.md) |

경로는 현재 기본값인 `API_PREFIX=api` 기준이다. `API_PREFIX=''`이면 `/auth/...`로 호출한다. API 서브도메인을 사용해도 경로 접두사는 설정값으로 결정한다.

## 합의한 사용자 정책

- 처음 검증된 지갑이면 `users`와 `user_wallets`를 함께 생성한다. 가입 화면은 없다.
- `display_name`은 암호학적 난수 4바이트의 소문자 16진수를 붙인 `사용자-a7f29c41` 형식으로 생성한다. 이름 중복을 허용하며 사용자 식별은 `users.id`로 한다.
- 기존 지갑은 기존 계정으로 로그인한다. 기존 이름과 아바타를 유지한다.
- `status=active`인 계정만 로그인하고 인증된 API를 사용할 수 있다. `suspended`와 `withdrawn`은 계정을 다시 생성하거나 지갑을 다른 계정에 옮기지 않고 거절한다.
- 새 지갑이 기존 로그인 쿠키와 함께 들어와도 기존 계정에 자동 연결하지 않는다. 지갑 연결·계정 병합·프로필 수정 API는 이번 범위에 포함하지 않는다.
- 여러 브라우저의 독립 세션을 허용한다. 로그아웃은 현재 쿠키가 가리키는 세션 하나에 적용한다.

## 현재 구조와 소유권

현재 샘플은 인메모리다. `AppModule`에 `DatabaseModule`과 `AuthModule`을 등록했고, 챌린지 발급은 PostgreSQL 연결과 `TransactionRunner`를 사용한다. 앱 시작에는 DB 연결이 필요하다.

아래는 전체 인증 기능의 목표 구조다. 현재 `auth.module.ts`, `auth-http.ts`, `create-challenge/`, `challenge/`를 구현했다. 나머지 책임과 세션 가드는 후속 구현 범위다.

```text
src/modules/auth/
├── auth.module.ts
├── auth-http.ts          # 인증 응답의 초기 캐시 금지 처리
├── create-challenge/     # HTTP 입력과 챌린지 발급 유스케이스
├── sign-in/              # 서명 검증과 로그인 유스케이스
├── get-current-user/     # 현재 사용자 조회 유스케이스
├── sign-out/             # 현재 세션 폐기 유스케이스
├── challenge/            # 챌린지 저장·단일 사용 정책
├── wallet-account/       # 사용자와 검증된 지갑의 계정 매핑
└── session/              # 세션 저장·검증·연장·폐기, 쿠키와 인증 가드
```

컨트롤러는 정의되지 않은 쿼리 무시, 본문의 허용 필드 선별과 DTO 검증, 쿠키 읽기·쓰기, HTTP 상태를 담당한다. 사용하지 않는 본문·쿼리는 DTO로 바인딩하지 않고 유스케이스에도 전달하지 않는다. 입력을 사용하는 경우에도 정의된 필드의 검증을 통과한 DTO만 전달하고 원본 본문·쿼리를 업무 처리에 사용하지 않는다. 유스케이스는 업무 흐름과 원자성 범위를 결정한다. 저장소는 기존 `pg` 연결 풀과 불투명 `TransactionContext`에 참여한다. HTTP 예외와 DB 클라이언트를 유스케이스의 입력·출력으로 넘기지 않는다.

인증 가드는 세션과 사용자 상태를 읽어 인증 주체를 전달하며 세션을 연장하지 않는다. `/auth/me`의 유스케이스는 사용하지 않는 본문·쿼리를 무시하고 세션 유효성을 다시 원자적으로 확인한 뒤 활동 시각을 갱신한다. 입력을 사용하는 API는 해당 입력의 검증까지 통과한 뒤 세션을 연장한다. 컨트롤러는 성공 결과에 맞춰 쿠키를 재발급한다.

다른 기능은 auth가 공개하는 인증 가드와 사용자 ID를 사용한다. 타 모듈이 auth의 저장소를 직접 호출하지 않는다. 사용자별 자원 권한은 해당 기능의 유스케이스에서 판단한다.

## 현행 DB 기준

로컬 `cameo-server-postgres`의 PostgreSQL 16.11, `cameo.public`에서 컬럼·제약·인덱스를 읽기 전용으로 확인했다.

| 테이블 | 사용 정책 |
| --- | --- |
| `users` | UUID, null을 허용하는 이름·아바타, 계정 상태(활성·정지·탈퇴), 로그인·수정·탈퇴 시각 |
| `user_wallets` | 사용자 FK. `(chain_namespace, address_key)` 유일. Solana는 `address_key=address`를 그대로 저장한다. |
| `auth_challenges` | `auth_method=siws`, 유일한 nonce, 서버가 발급한 SIWS 입력을 `verification_payload`에 저장, 브라우저 연결값 해시, 5분 만료, 사용 시각 |
| `auth_sessions` | 사용자 FK, 유일한 토큰 해시, 활동 시각, 미접속 만료와 절대 만료, 폐기 시각 |

Solana 주소는 대소문자를 구분하며 Base58 디코딩 결과가 32바이트인지 애플리케이션에서도 검증한다. DB 정규식만으로 공개키 유효성을 판단하지 않는다. 사용자·지갑 상태 변경 시 `updated_at`, `last_login_at`, `last_used_at`을 명시적으로 갱신한다. 현재 갱신 트리거는 없다.

현재 네 테이블은 RLS가 켜져 있고 정책은 없으며, 로컬 접속 역할 `cameo`는 소유자이자 최고 권한 역할이므로 RLS를 우회한다. 실제 API 접속 역할의 읽기·쓰기 권한을 확인해야 한다. 테이블 소유자가 아닌 일반 역할에 동일 권한이 있다고 가정하지 않는다.

현재 Compose에는 테이블 초기화 SQL이나 마이그레이션 연결 설정이 없다. 챌린지 테이블은 `db/migrations/2026-10-01-01-auth-challenges.sql`로 재현하며 적용 절차는 [실행 가이드](../../../README.md)에 설명했다. 기존 로컬 데이터와 테이블을 초기화하지 않는다. 다른 인증 테이블의 기준 SQL은 해당 기능 구현 단계에서 추가한다.

## SIWS와 챌린지

- 서버가 챌린지와 모든 SIWS 입력을 생성한다. 클라이언트가 제출한 기대 메시지나 nonce를 검증 기준으로 사용하지 않는다.
- `domain`과 `uri`는 정확히 허용된 요청 출처에서 서버가 구성한다. API 호스트나 임의 본문 값으로 구성하지 않는다. 운영은 HTTPS, 로컬은 `http://localhost:5173` 기준이다.
- `version=1`, `chainId=mainnet`, `statement=Sign in to Cameo.`로 고정한다. `mainnet`은 로그인 메시지의 서비스 기준이며 로그인에 RPC, 온체인 거래, 잔액 조회는 필요하지 않다.
- nonce는 난수 32바이트를 소문자 16진수 64자로 표현한다. `requestId`는 챌린지 UUID다.
- 발급·만료 시각은 PostgreSQL 시각으로 산정한다. `issuedAt`과 `expirationTime`은 DB의 `created_at`과 `expires_at`을 UTC ISO 8601 문자열로 표현한다. 유효성은 DB 현재 시각으로 검사하며 만료 시각과 같으면 거절한다.
- 서버는 브라우저 연결값을 별도 HttpOnly 쿠키로 발급하고 SHA-256 해시만 DB에 저장한다. 원문은 응답 JSON에 포함하지 않는다.
- 서명 주소, Ed25519 서명, 메시지 형식과 모든 발급 필드를 검증한다. 기대 주소는 실제 서명 주소를 사용하고, 나머지 기대 입력은 저장된 검증용 입력에서 읽는다. 추가 필드를 포함한 변형 메시지도 거절하도록 표준 방식으로 재구성한 기대 메시지와 바이트 일치를 확인한다.
- `verifySignIn` 등 SIWS 표준 검증 도구는 형식·서명 검증에 사용한다. 만료·요청 출처·브라우저 연결·단일 사용은 서버가 별도로 강제한다. 패키지의 현재 배포 형식과 프로젝트 CommonJS 호환성은 구현 전에 확인한다.

JSON 전송에서는 `signedMessage`와 `signature`를 패딩을 포함한 표준 Base64 문자열로 사용한다. `signedMessage`는 지갑이 반환한 원본 바이트다. 프론트가 메시지를 다시 만들거나 문자열로 변환해 서명 대상을 바꾸지 않는다.

## 원자성과 실패 상태

로그인 성공 시 하나의 DB 트랜잭션에서 챌린지 조건부 소비, 기존 계정 확인 또는 최초 계정·지갑 생성, 로그인 시각 갱신, 새 세션 생성, 같은 브라우저의 기존 세션 폐기를 처리한다. 커밋 후 쿠키를 발급한다.

같은 지갑의 최초 로그인을 직렬화하는 트랜잭션 자문 잠금과 기존 유일 제약을 함께 사용한다. 조회만으로 중복을 예방하지 않는다. 경합·제약 실패로 트랜잭션이 롤백되면 사용자 행도 롤백하여 고아 계정을 남기지 않는다.

잘못된 서명은 챌린지를 소비하지 않는다. 유효한 서명이지만 계정 상태 때문에 거절할 때는 챌린지 소비만 커밋하고 세션은 생성하지 않는다. DB 실패는 전체 트랜잭션을 롤백한다. HTTP 응답 전송 실패는 DB 커밋을 되돌릴 수 없으며 클라이언트는 `/auth/me`로 상태를 확인한다.

## 세션과 쿠키

세션 토큰과 브라우저 연결값은 각각 독립적인 난수 32바이트를 패딩 없는 Base64url 43자로 표현한다. DB에는 원문 문자열의 SHA-256 소문자 16진수 64자만 저장한다. 원문·서명·nonce를 요청 본문이나 로그에 남기지 않는다.

| 환경 | 세션 쿠키 | 챌린지 연결 쿠키 | 속성 |
| --- | --- | --- | --- |
| 운영 HTTPS | `__Host-cameo_session` | `__Host-cameo_auth_binding` | HttpOnly, Secure, SameSite=Lax, Path=/, Domain 생략 |
| 로컬 HTTP | `cameo_session` | `cameo_auth_binding` | HttpOnly, Secure=false, SameSite=Lax, Path=/, Domain 생략 |

운영 쿠키는 API 호스트에만 발급한다. 프론트 `app.example.com`과 API `api.example.com`은 양쪽 HTTPS를 사용한다. 모든 쿠키 발급·갱신·삭제는 해당 환경의 이름과 속성을 일관되게 사용한다. 토큰은 JSON이나 Authorization 헤더로 반환하지 않는다.

세션 생성 시 미접속 만료는 생성 시각+7일, 절대 만료는 생성 시각+30일이다. 사용하는 입력의 검증을 마친 인증 요청이 유효한 세션과 활성 계정을 확인하면 `last_seen_at=현재 시각`, `expires_at=min(현재 시각+7일, absolute_expires_at)`로 갱신하고 쿠키를 재발급한다. 본문·쿼리를 사용하지 않는 API는 해당 입력이 전달되어도 무시하고 인증 성공을 활동으로 계산한다. 토큰과 절대 만료는 바꾸지 않는다. 세션이 이미 만료되었거나 폐기되었으면 되살리지 않는다.

쿠키 `Max-Age`는 DB 만료까지 남은 초를 올림하여 발급한다. 실제 허용 여부는 DB 만료로 판단한다. 현재 활동 기준은 인증된 HTTP 요청이다. 새 WebSocket 연결이나 메시지의 인증·활동 갱신은 별도 기능을 설계할 때 정한다.

## 공통 HTTP 계약

- 현재 성공 응답 형식 `{ statusCode, success: true, data }`와 오류 응답 형식 `{ statusCode, success: false, code, message, error, traceId }`를 유지한다.
- 쿼리는 API에 정의된 파라미터만 사용하고 검증한다. 정의되지 않은 파라미터는 무시하며 그 존재만으로 400을 반환하지 않는다. 현재 네 인증 API에는 정의된 쿼리가 없으므로 전달된 쿼리를 모두 무시한다.
- 본문은 허용된 필드만 남기고 정의되지 않은 필드를 제거한 뒤 검증한다. 추가 필드 자체는 400의 사유가 아니다. 챌린지 발급·현재 사용자 조회·로그아웃은 허용된 본문 필드가 없으므로 본문을 생략할 수 있고, 전달되어도 업무 처리에 사용하지 않는다. 로그인은 허용된 네 필드만 남겨 검증한다.
- 허용 필드의 필수 값 누락, 잘못된 타입, 허용되지 않은 null·빈 문자열과 잘못된 인코딩은 400이다. 필수 본문의 누락이나 객체가 아닌 본문도 400이다. 선택 필드는 생략할 수 있으며, 전달된 값은 정의된 검증을 적용한다. 문자열을 자동 변환하거나 앞뒤 공백을 제거하지 않는다.
- 전역 DTO 설정은 `whitelist=true`, `forbidNonWhitelisted=false`다. 추가 필드를 제거하고 허용 필드를 검증한다. 챌린지 API는 본문·쿼리를 업무 입력으로 바인딩하지 않으며 전달되어도 사용하지 않는다.
- 무시 정책은 HTTP 계층에서 정상적으로 해석된 요청에 적용한다. 잘못된 JSON 문법 등 요청 파싱 자체의 실패는 400이다.
- CORS는 정확한 프론트 요청 출처 목록과 `credentials=true`를 사용한다. 프론트는 모든 인증 요청에 `credentials: 'include'`를 사용한다. 출처 목록의 와일드카드·경로·빈 목록, 운영의 HTTP 출처, `CORS_CREDENTIALS=false`는 앱 시작 시 거절한다.
- 모든 POST 인증 API는 허용된 `Origin`을 요구한다. 요청 출처 누락, `null`, 비허용 값은 `403 AUTH_ORIGIN_NOT_ALLOWED`다. 로그인은 챌린지 URI의 요청 출처와도 일치해야 한다. CORS 헤더만으로 요청 실행을 차단했다고 간주하지 않는다.
- 모든 인증 응답과 오류에는 `Cache-Control: no-store`를 적용한다. 서버 생성 `x-request-id`와 오류의 `traceId`는 기존 생명주기 처리를 따른다.
- 기존 프로세스별 IP 제한을 적용한다. 기본 한도는 60초 100회이며 429 시 `Retry-After`를 반환한다. 다중 인스턴스 사이의 공유 한도는 이번 범위에 포함하지 않는다.
- 업무 오류 종류에 접근 거절(403)을 추가했다. 인증 실패(401) 매핑은 로그인·세션 구현 단계에서 추가한다. 일반 SDK·SQL 오류는 상세를 노출하지 않는 500으로 처리한다.

| 공통 오류 | 상태 | 공개 메시지 | `error` |
| --- | --- | --- | --- |
| `BadRequestException` | 400 | 사용하는 입력의 검증 결과 또는 요청 파싱 오류 메시지. 소비자는 메시지에 의존하지 않는다. | `Bad Request` |
| `AUTH_ORIGIN_NOT_ALLOWED` | 403 | `허용되지 않은 요청 출처입니다.` | `Forbidden` |
| `ThrottlerException` | 429 | `ThrottlerException: Too Many Requests` | `ThrottlerException` |
| `INTERNAL_SERVER_ERROR` | 500 | `Internal server error` | `Internal Server Error` |

## 검증 기준

각 API 스펙의 정상·실패 계약을 확인한다. 지갑 증명은 실제 Phantom PC 확장 프로그램에서 한 번 연결하며, 서버 자동 검증에서는 테스트용 Ed25519 키로 유효한 SIWS 메시지를 생성한다.

정의되지 않은 쿼리의 추가 전달과 본문의 추가 필드 제거가 정상 처리되는지 확인한다. 허용 필드가 없는 API는 본문·쿼리를 생략하거나 전달해도 동일한 업무 결과로 처리되어야 한다. 제거한 사용자 ID·주소·SIWS 기대 입력 등으로 인증 주체, 처리 대상, 서명 검증 기준을 바꿀 수 없어야 한다. 로그인 본문의 필수 입력과 허용 필드 검증은 유지한다.

실제 PostgreSQL 통합 검증은 챌린지 재사용·만료·다른 브라우저·잘못된 요청 출처, 동시 최초 로그인, 비활성 계정, 트랜잭션 실패, 미접속·절대 만료, 연장과 로그아웃의 경합을 포함한다. 시간 경계는 대기 대신 기준 시각을 제어하여 확인한다.

챌린지 API는 Node 기본 테스트 실행기로 실제 HTTP·PostgreSQL을 검증한다. `npm test`는 DB의 임시 스키마에서 실행하며 기존 데이터는 변경하지 않는다. 나머지 인증 API는 아직 실행 검증하지 않았다. typecheck, lint, format:check, build도 수행한다.

## 근거

- [기존 HTTP 계약](../../api/app.md), [현재 구현 관례](../../CONVENTION.md)
- [Phantom SIWS 명세](https://github.com/phantom/sign-in-with-solana): 표준 입력·출력과 서버 검증 절차.
- [Wallet Standard 검증 구현](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/util/src/signIn.ts): 표준 메시지와 서명 검증 기준.
- [MDN 쿠키 설정](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie): 호스트 전용 쿠키, HttpOnly, Secure와 쿠키 이름 규칙.
- [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS): 인증 정보를 포함한 요청과 정확한 요청 출처 허용.
- [OWASP CSRF 기준](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): 상태 변경 요청의 출처 검증.
