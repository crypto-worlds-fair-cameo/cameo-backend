# cameo 백엔드 실행 가이드

NestJS 12 · TypeScript 7 · Node.js 24 · PostgreSQL 16 기반 백엔드다. 현재 Solana SIWS **챌린지 발급·로그인 API**를 제공한다. 로그인 사용에는 PostgreSQL 연결과 `auth_challenges`, `users`, `user_wallets`, `auth_sessions` 테이블이 필요하다.

## 로컬 준비

이 문서의 명령은 backend 폴더에서 실행한다.

```bash
nvm install
nvm use
npm ci
```

`.env`가 없으면 아래 설정표를 참고해 직접 만든다. 로컬에 `.env.example`이 있으면 복사해 사용할 수 있다. `.env`, `.env.example`, `.agents/skills/`는 Git에서 관리하지 않는다. 기존 Docker 볼륨을 사용한다면 컨테이너가 생성될 때 사용한 계정·비밀번호·DB 이름에 맞춰야 한다.

| 설정 | 기준 |
| --- | --- |
| `NODE_ENV` | 로컬 `development`, 운영 `production` |
| `HOST`, `PORT` | 기본 `127.0.0.1:5000` |
| `API_PREFIX` | 기본 `api`, 빈 문자열이면 접두사 없음 |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | 접속할 PostgreSQL 연결값 |
| `CORS_ORIGIN_LIST` | 정확한 프론트 출처 목록. 기본 `http://localhost:5173`. 여러 출처는 쉼표로 구분 |
| `CORS_CREDENTIALS` | 쿠키 발급을 위해 `true` 사용 |
| `TRUST_PROXY_HOPS` | 기본 `0`, 배포 시 신뢰할 프록시 홉 수 |
| `RATE_LIMIT_TTL_MS`, `RATE_LIMIT_LIMIT` | 기본 60초당 100회 |

운영 프론트와 API는 HTTPS를 사용한다. 출처 설정에는 경로·후행 슬래시·와일드카드를 넣지 않는다. 운영 환경의 HTTP 출처와 `CORS_CREDENTIALS=false`는 시작 시 거절한다. DB의 TLS·CA·연결 풀·제한 시간 설정은 `src/config/database.config.ts`에서 확인할 수 있다.

## DB와 테이블 준비

Compose는 `.env`의 DB 연결값으로 컨테이너를 구성하고 로컬에만 포트를 공개한다.

```bash
docker compose up -d postgres
```

새 DB에 인증 테이블을 만들려면 다음 기준 SQL을 순서대로 적용한다. 기존 테이블과 데이터를 유지하며 서버 시작 시 자동으로 실행하지 않는다. `IF NOT EXISTS`는 이미 존재하는 테이블의 구조 차이를 수정하지 않는다.

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < db/migrations/2026-10-01-01-auth-challenges.sql
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < db/migrations/2026-10-01-02-auth-wallet-accounts-and-sessions.sql
```

테이블은 RLS를 사용한다. 현재 기준 SQL에는 별도 정책이 없으므로 서버의 접속 역할은 테이블 소유자이거나 해당 작업을 수행할 RLS 권한이 있어야 한다.

## 실행과 호출

```bash
npm run start:dev
```

```bash
curl http://localhost:5000/api/health
curl http://localhost:5000/api/ready
curl -i -X POST http://localhost:5000/api/auth/challenges \
  -H 'Origin: http://localhost:5173' \
  -c /tmp/cameo-auth-cookies.txt
```

챌린지 발급은 HTTP 201로 `challengeId`와 `signInInput`을 반환하고, HttpOnly 브라우저 연결 쿠키를 설정한다. 프론트 요청에는 `credentials: 'include'`를 지정한다. 로컬 프론트가 `http://localhost:5173`이면 브라우저의 API 주소도 `http://localhost:5000/api`로 맞춘다. 운영은 같은 최상위 도메인의 프론트·API 서브도메인으로 배치한다. 본문·쿼리는 사용하지 않으며 5분 만료 시각은 DB 시각으로 산정한다. `/ready`는 DB 쿼리 성공 시 `database: "up"`을 반환한다.

로그인은 지갑이 반환한 SIWS 원본 메시지와 Ed25519 서명을 표준 Base64로 보내 `POST /api/auth/login`을 호출한다. 처음 검증된 지갑은 계정과 표시 이름을 자동 생성하며 성공 시 HttpOnly 세션 쿠키를 발급한다. 지갑 앱 이름은 계정 식별에 사용하지 않는다. 요청·오류·쿠키 계약은 [로그인 스펙](docs/api/auth/login.md)을 따른다. 현재 사용자 조회와 로그아웃은 아직 제공하지 않는다.

운영 빌드와 실행은 `npm run build`, `npm run start:prod`를 사용한다. 환경변수를 변경하면 서버를 다시 시작한다.

## 검증

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

저장소에는 자동 테스트 코드와 테스트 실행 스크립트를 포함하지 않는다. 변경한 API의 입력·응답·오류는 개발 환경에서 실제 호출해 확인한다.

## 구조와 문서

- `src/modules/auth/create-challenge`: 챌린지 발급 컨트롤러·유스케이스
- `src/modules/auth/login`: 로그인 컨트롤러·유스케이스
- `src/modules/auth/challenge`: 챌린지 계약·저장·잠금·소비
- `src/modules/auth/siws`: Solana SIWS 입력 생성·주소·메시지·서명 검증
- `src/modules/auth/wallet-account`: 지갑 식별자 잠금·계정 생성·활동 갱신
- `src/modules/auth/session`: 토큰 해시 저장·세션 발급·제출된 기존 세션 폐기
- `src/database`: 전역 DB 연결·트랜잭션·준비 상태 확인
- `src/http`: 공통 응답·오류·검증·요청 제한
- [챌린지 API 스펙](docs/api/auth/challenges.md), [로그인 API 스펙](docs/api/auth/login.md)
- 구현 예정 API: [현재 사용자](docs/api/auth/me.md), [로그아웃](docs/api/auth/logout.md)
- [공개 운영·샘플 API](docs/api/app.md), [구현 관례](docs/CONVENTION.md)
