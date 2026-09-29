# Backend Convention

설계·구현 기준은 [nestjs-backend-development](../../.agents/skills/nestjs-backend-development/SKILL.md), HTTP 계약·문서는 [back-api-doc-rules](../../.agents/skills/back-api-doc-rules/SKILL.md)를 따른다. 이 문서는 현재 보일러플레이트의 구체적인 연결 방식을 설명한다.

## 실행과 도구

- Node 24.21.0 LTS 기준 (`server/.nvmrc`). NestJS 12, TypeScript 7, CommonJS 출력과 NodeNext 모듈 해석을 사용한다.
- `npm run build`: 이전 dist 제거 → TypeScript 컴파일 → 경로 별칭 해석. `npm run typecheck`는 테스트까지 검사한다.
- `npm run start:dev`: nodemon으로 변경 감지 후 TypeScript CLI 재빌드·재시작. `npm run start:prod`: 빌드된 JavaScript 실행.
- Jest 30 + SWC는 테스트 변환만 담당한다. 타입 검사는 별도 실행해야 한다. Nest 12 ESM 의존성을 위해 Jest 명령에 VM modules 플래그를 사용한다.
- Oxlint는 소스·테스트를 검사하고, Prettier는 형식을 검사한다. `lint`는 파일을 수정하지 않으며 수정은 `lint:fix`로 분리한다.
- 2-space 들여쓰기와 세미콜론, 모듈 경계의 `@/` 별칭을 사용한다.

## Bootstrap과 HTTP

`main.ts → app.factory.ts → AppModule`에서 초기화한다. 전역 설정은 `configureApp()`에 둔다.

- Helmet 보안 헤더, `x-powered-by` 제거, 서버 생성 request ID와 응답 `x-request-id`를 적용한다.
- `TRUST_PROXY_HOPS=0`이 기본이며, 실제 신뢰할 프록시 홉 수를 배포 구성에 맞춰 지정한다. 더 짧은 우회 경로가 있으면 홉 수만으로 신뢰를 판단하지 않도록 네트워크에서 제한한다.
- 종료 신호에서 Nest shutdown hook을 호출한다.
- CORS는 명시한 origin만 허용한다. wildcard와 credentials를 함께 설정하면 부팅을 거부한다. CORS는 인증·인가를 대체하지 않는다.
- ValidationPipe는 transform/whitelist/forbidNonWhitelisted를 사용하되 implicit conversion은 끈다. 필요한 숫자·boolean 변환은 DTO에서 명시하고 테스트한다.
- 요청 제한은 `express-rate-limit`의 프로세스별 메모리 저장소를 사용한다. `RATE_LIMIT_TTL_MS`/`RATE_LIMIT_LIMIT`로 한도를 설정한다. 여러 인스턴스가 한도를 공유해야 하면 외부 저장소를 추가한다. Nest Throttler 데코레이터는 사용하지 않는다.

성공 응답은 `{ statusCode, success: true, data }`다. Controller는 DTO만 반환한다. 오류 응답은 `{ statusCode, success: false, code, message, error, traceId }`다. 5xx 상세 정보는 공개하지 않으며, 내부 stack은 서버 로그에 남긴다. 오류 응답 작성은 전역 HttpExceptionFilter만 담당하며, rate limiter도 429 예외를 next(error)로 전달한다. 필터는 5xx 원인만 http.error 이벤트로 기록한다. 이미 종료된 응답에는 쓰지 않고, 헤더 전송 후 오류는 연결을 종료한다. HTTP 상세 계약은 [API 문서](api/app.md)를 따른다.

## 기능 모듈과 업무 오류

`presentation → application → domain`, `infrastructure → 계약` 방향을 유지한다. 필요한 책임만 만들며 빈 폴더·형식적인 entity·read/write 쌍을 강제하지 않는다.

- Controller는 DTO로 입력을 검증하고 use case를 호출한다.
- Use case는 `execute()`로 업무 흐름을 조합한다. DB client나 HTTP exception에 의존하지 않는다.
- Domain은 plain TypeScript이며 업무 실패는 `BusinessError`와 기능별 error code를 사용한다.
- 기능별 HTTP mapper를 `HttpErrorMapperRegistry`에 등록한다. 알려진 코드만 공개 상태·메시지로 변환하며, 등록되지 않은 업무 오류는 500이다.
- SampleModule은 기능별 오류 코드와 공개 메시지를 mapper에서 정의한다.
- Repository 구현 바인딩은 기능 모듈에서 수행한다. 같은 구현체를 공유할 때 `useExisting`을 사용한다.
- 신규 모듈은 루트 `scripts/create-module`로 생성할 수 있다.

## 설정·로그·외부 HTTP

`CoreModule`에서 ConfigModule을 초기화하고, `environment.validation.ts`가 부팅 전 환경변수를 검증한다. 기능 코드에서는 `ConfigService<AllConfigType>`를 사용한다. 새 설정은 `.env.example`과 함께 갱신한다.

운영 로그는 JSON stdout/stderr, 개발 로그는 읽기 쉬운 콘솔 형식이다. 로컬 로그 디렉토리와 rotating-file 의존성은 없다. HTTP 로그에는 query 값을 포함하지 않는다. 외부 HTTP는 `core/http-client`를 사용한다.

## PostgreSQL과 트랜잭션

기본 샘플은 인메모리 저장소라 DB 없이 실행된다. DB가 필요한 프로젝트는 `DatabaseModule`을 AppModule과 DB를 사용하는 기능 모듈에 import한다.

- Pool은 연결/idle/query/idle transaction timeout, keepalive와 idle error listener를 사용한다.
- `DB_SSL=true`는 인증서 검증을 켠다. 사설 CA가 필요하면 `DB_SSL_CA`에 PEM을 지정한다. 검증 비활성화를 기본값으로 사용하지 않는다.
- 초기 연결 실패는 예외로 전파하며 풀을 닫는다. 앱 종료 시 풀을 한 번 정리한다.
- Application은 `TransactionRunner.run()`과 불투명 `TransactionContext`를 사용한다. Repository 구현은 `getPgExecutor(pool, context)`로 같은 연결에 참여한다.
- callback 성공은 commit, 실패는 rollback 후 release한다. rollback까지 실패하면 손상된 연결을 폐기한다. 만료되거나 알 수 없는 context는 거절한다.
- `/health`는 프로세스 생존, `/ready`는 DB가 연결된 경우 실제 `select 1`을 검사한다. DB 미사용이면 `database: disabled`, 실패하면 503이다.

## 검증

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -- --runInBand`, `npm run test:e2e -- --runInBand`, `npm run build`를 사용한다.

실제 DB 검증은 전용 임시 DB의 `TEST_DATABASE_URL`을 지정하고 `npm run test:db`를 실행한다. 임시 테이블로 commit/rollback, statement timeout 복구, context 만료, readiness, 연결 반환을 검사한다.

## 요청 생명주기와 테스트 설정

- 요청 미들웨어는 서버에서 requestId를 생성해 response.locals와 x-request-id 응답 헤더에 저장한다. 클라이언트 요청 헤더는 수정하지 않으며 오류 응답 traceId도 같은 ID를 사용한다.
- 접근 로그(http.request)는 response의 finish/close에서 요청당 한 번만 기록한다. finish는 서버 전송 완료이며 클라이언트 수신을 보장하지 않는다. close에서 writableFinished가 false면 aborted다.
- 헤더 전송 전 중단의 statusCode는 null이다. 전송 후 중단은 실제 상태 코드와 aborted를 함께 기록한다. 소요 시간은 단조 증가 시계로 측정한다.
- 완료된 4xx 및 중단 요청은 warn, 5xx는 error, 나머지는 info다. 5xx 원인 로그와 접근 로그는 같은 requestId로 연결한다. 접근 로그에는 query·body·인증 헤더를 넣지 않는다.
- 성공 응답 인터셉터는 응답 형식만 담당한다. 접근 로그 미들웨어는 CORS·body parser보다 먼저 설치되어 preflight와 잘못된 JSON 요청도 기록한다.
- GET/HEAD의 정확한 health/ready 경로만 API 요청 제한에서 제외한다. API prefix와 Express 기본 경로 규칙(대소문자 무시, 후행 슬래시 허용)을 적용한다. POST와 유사 경로는 제외하지 않는다.
- Jest 공통 설정은 jest.shared.cjs에 둔다. 단위 설정(jest.config.cjs)은 src/**/*.spec.ts, e2e 설정(test/jest-e2e.config.cjs)은 test/**/*.e2e-spec.ts만 실행한다. 두 설정은 같은 SWC 변환과 @/ → src/ 별칭을 사용한다.
