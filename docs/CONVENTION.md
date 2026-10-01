# Backend Convention

설계·구현 기준은 로컬 `nestjs-feature-first-architecture` 스킬, HTTP 계약·문서는 로컬 `back-api-doc-rules` 스킬를 따른다. 이 문서는 현재 보일러플레이트의 구체적인 연결 방식을 설명한다.

## 실행과 도구

- Node 24.21.0 LTS 기준 (`server/.nvmrc`). NestJS 12, TypeScript 7, CommonJS 출력과 NodeNext 모듈 해석을 사용한다.
- `npm run build`: 이전 dist 제거 → TypeScript 컴파일 → 경로 별칭 해석. `npm run typecheck`는 파일 생성 없이 타입을 검사한다.
- `npm run start:dev`: nodemon으로 변경 감지 후 TypeScript CLI 재빌드·재시작. `npm run start:prod`: 빌드된 JavaScript 실행.
- Oxlint는 소스를 검사하고, Prettier는 형식을 검사한다. `lint`는 파일을 수정하지 않으며 수정은 `lint:fix`로 분리한다.
- 2-space 들여쓰기와 세미콜론, 모듈 경계의 `@/` 별칭을 사용한다.

## Bootstrap과 HTTP

`main.ts → app.factory.ts → AppModule`에서 초기화한다. `AppModule`은 config·logging·HTTP·system·기능 모듈을 직접 조립하고, 전역 HTTP 설정은 `configureApp()`에 둔다.

HTTP 오류 처리는 `http/errors`, request ID와 완료·중단 로그는 `http/request-lifecycle`, 요청 제한과 probe 예외는 `http/rate-limit`에 둔다. 응답 interceptor, CORS와 validation 설정은 `http` 바로 아래에 둔다.

- Helmet 보안 헤더, `x-powered-by` 제거, 서버 생성 request ID와 응답 `x-request-id`를 적용한다.
- `TRUST_PROXY_HOPS=0`이 기본이며, 실제 신뢰할 프록시 홉 수를 배포 구성에 맞춰 지정한다. 더 짧은 우회 경로가 있으면 홉 수만으로 신뢰를 판단하지 않도록 네트워크에서 제한한다.
- 종료 신호에서 Nest shutdown hook을 호출한다.
- CORS는 설정한 origin 목록과 credentials 값을 사용한다. CORS는 인증·인가를 대체하지 않는다.
- ValidationPipe는 transform/whitelist를 사용하고 `forbidNonWhitelisted=false`로 추가 필드를 제거한다. 정의되지 않은 쿼리는 무시하고 본문은 허용된 필드만 남겨 검증한다. implicit conversion은 끄며 필요한 숫자·boolean 변환은 DTO에서 명시한다.
- 요청 제한은 `express-rate-limit`의 프로세스별 메모리 저장소를 사용한다. `RATE_LIMIT_TTL_MS`/`RATE_LIMIT_LIMIT`로 한도를 설정한다. 여러 인스턴스가 한도를 공유해야 하면 외부 저장소를 추가한다. Nest Throttler 데코레이터는 사용하지 않는다.

성공 응답은 `{ statusCode, success: true, data }`다. Controller는 DTO만 반환한다. 오류 응답은 `{ statusCode, success: false, code, message, error, traceId }`다. 5xx 상세 정보는 공개하지 않으며, 내부 stack은 서버 로그에 남긴다. 오류 응답 작성은 전역 HttpExceptionFilter만 담당하며, rate limiter도 429 예외를 next(error)로 전달한다. 필터는 5xx 원인만 http.error 이벤트로 기록한다. 이미 종료된 응답에는 쓰지 않고, 헤더 전송 후 오류는 연결을 종료한다. HTTP 상세 계약은 [API 문서](api/app.md)를 따른다.

## 기능 모듈과 업무 오류

현재 샘플은 `list-samples`, `get-sample-by-id`, `update-sample-name`에 각 Controller와 UseCase를 두고, 공유 상태와 저장은 `sample-item`이 소유한다. 새 기능의 배치와 분리 기준은 위 설계·구현 스킬을 따른다.

- Controller는 작은 요청 DTO를 같은 파일에 두고 입력을 검증한 뒤 use case를 호출한다.
- Use case는 `execute()`로 업무 흐름을 조합한다. DB client나 HTTP exception에 의존하지 않는다.
- `SampleRepository`는 샘플 공유 상태와 기본 query·저장을 한 인스턴스에서 관리하며 UseCase가 구체 provider를 직접 주입받는다.
- 샘플 상태는 plain TypeScript 값이며, 이름 변경 규칙은 해당 UseCase가 처리한다. 업무 실패는 `BusinessError({ code, kind, message })`로 던진다. `code`는 안정적인 공개 업무 코드, `kind`는 실패 종류, `message`는 공개 가능한 업무 설명이다.
- 전역 `HttpExceptionFilter`가 `kind`를 HTTP 상태로 변환하고 업무 코드와 메시지를 응답에 사용한다. 현재 `not_found`는 404, `validation`은 400, `forbidden`은 403이다. 기존 종류의 업무 오류를 추가할 때는 기능별 mapper나 모듈 등록이 필요하지 않다. 알 수 없는 실패 종류와 일반 SDK·DB 오류는 500으로 처리한다.
- 샘플의 오류 정의는 `sample-item.ts`의 `SampleErrors`에 모으고, UseCase가 발생 지점에서 새 `BusinessError`를 생성한다. 한 기능만 사용하는 작은 오류 정의는 그 UseCase에 직접 둘 수 있다. `sample-http.ts`는 응답 타입과 필드 선택을 담당한다.
- 루트 `scripts/create-module`은 업무 모듈만 생성하며, `--feature`를 지정하면 한 UseCase를 추가한다. `--http METHOD path`를 함께 지정한 경우에만 Controller를 생성한다.
- 생성기는 기존 module 파일을 수정하지 않는다. 출력된 import와 `controllers`·`providers` 등록을 검토해 명시적으로 연결한다.
- scaffold는 일반 `Error`로 미구현 상태를 표시한다. HTTP 입력·인증·응답·공개 오류는 실제 요구사항으로 구현하고 API 문서와 실행 검증을 함께 갱신한다.

## 설정·로그·외부 HTTP

`AppModule`에서 전역 ConfigModule을 초기화하고, 각 `*.config.ts`에서 환경변수의 기본값과 타입 변환을 처리한다. 환경변수 사전 검증은 기본 구성에 포함하지 않으며 프로젝트 요구에 따라 도입한다. 기능 코드에서는 `ConfigService<AllConfigType>`를 사용한다. 새 설정은 `.env.example`과 함께 갱신한다.

운영 로그는 JSON stdout/stderr, 개발 로그는 읽기 쉬운 콘솔 형식이다. 로컬 로그 디렉토리와 rotating-file 의존성은 없다. HTTP 로그에는 query 값을 포함하지 않는다. 외부 HTTP가 필요한 기능은 해당 책임 안에서 필요한 client나 SDK를 직접 사용하며 단순 전달 wrapper를 추가하지 않는다.

## PostgreSQL과 트랜잭션

샘플은 인메모리 저장소지만, 챌린지 발급을 위해 `DatabaseModule`을 AppModule에 한 번 등록했다. 앱 시작에는 DB 연결이 필요하다. 이 전역 모듈이 하나의 PostgreSQL pool과 트랜잭션·readiness provider를 제공한다.

- Pool은 연결/idle/query/idle transaction timeout, keepalive와 idle error listener를 사용한다.
- `DB_SSL=true`는 인증서 검증을 켠다. 사설 CA가 필요하면 `DB_SSL_CA`에 PEM을 지정한다. 검증 비활성화를 기본값으로 사용하지 않는다.
- 초기 연결 실패는 예외로 전파하며 풀을 닫는다. 앱 종료 시 풀을 한 번 정리한다.
- UseCase는 `database/transaction/transaction-runner`의 `TransactionRunner.run()`과 불투명 `TransactionContext`를 사용한다. Repository 구현은 `database/transaction/pg-executor`의 `getPgExecutor(pool, context)`로 같은 연결에 참여한다.
- callback 성공은 commit, 실패는 rollback 후 release한다. rollback까지 실패하면 손상된 연결을 폐기한다. 만료되거나 알 수 없는 context는 거절한다.
- `/health`는 프로세스 생존, `/ready`는 DB가 연결된 경우 실제 `select 1`을 검사한다. DB 미사용이면 `database: disabled`, 실패하면 503이다.

## 검증

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`를 사용한다. 변경한 API의 입력·응답·오류는 실행해서 확인한다.

`npm test`는 Node 기본 테스트 실행기로 챌린지의 HTTP·실제 DB·트랜잭션 동작을 확인한다. `.env`의 개발용 DB에 임시 스키마를 생성하고 종료 시 해당 스키마만 정리한다. Nest CLI의 spec 파일 자동 생성은 기본적으로 끈다.

## 요청 생명주기

- 요청 미들웨어는 서버에서 requestId를 생성해 response.locals와 x-request-id 응답 헤더에 저장한다. 클라이언트 요청 헤더는 수정하지 않으며 오류 응답 traceId도 같은 ID를 사용한다.
- 접근 로그(http.request)는 response의 finish/close에서 요청당 한 번만 기록한다. finish는 서버 전송 완료이며 클라이언트 수신을 보장하지 않는다. close에서 writableFinished가 false면 aborted다.
- 헤더 전송 전 중단의 statusCode는 null이다. 전송 후 중단은 실제 상태 코드와 aborted를 함께 기록한다. 소요 시간은 단조 증가 시계로 측정한다.
- 완료된 4xx 및 중단 요청은 warn, 5xx는 error, 나머지는 info다. 5xx 원인 로그와 접근 로그는 같은 requestId로 연결한다. 접근 로그에는 query·body·인증 헤더를 넣지 않는다.
- 성공 응답 인터셉터는 응답 형식만 담당한다. 접근 로그 미들웨어는 CORS·body parser보다 먼저 설치되어 preflight와 잘못된 JSON 요청도 기록한다.
- GET/HEAD의 정확한 health/ready 경로만 API 요청 제한에서 제외한다. API prefix와 Express 기본 경로 규칙(대소문자 무시, 후행 슬래시 허용)을 적용한다. POST와 유사 경로는 제외하지 않는다.
