# Server 시작 가이드

NestJS · TypeScript 기반의 백엔드입니다. **기본 샘플은 메모리 저장소를 사용하므로 DB 없이 시작할 수 있습니다.** 아래 순서로 환경을 준비하고 첫 기능을 추가하세요.

## 1. 프로젝트의 서버 기준 정의

저장소 루트의 [PROJECT.md](../PROJECT.md)에 첫 도메인, API prefix, 인증·인가 필요 여부와 DB 사용 계획을 작성합니다. 프론트는 별도로 실행·배포하며 이 서버가 정적 프론트 파일을 제공하지 않습니다.

## 2. 실행 환경 설치

저장소 루트에서 실행합니다. nvm이 설치되어 있어야 합니다.

```bash
cd server
nvm install
nvm use
npm ci
cp .env.example .env
```

Node 버전은 `.nvmrc`의 **24.21.0**을 사용합니다. `cp`는 `.env`가 없는 최초 설정 때만 실행하세요. 이후 명령은 별도 안내가 없으면 `server/` 기준입니다.

## 3. 환경변수 설정

먼저 `.env`에서 아래 값을 프로젝트에 맞춥니다.

| 설정 | 기본값·설정 기준 |
|---|---|
| `APP_NAME`, `APP_VERSION` | 프로젝트 이름과 버전 |
| `NODE_ENV` | 로컬 `development`, 운영 `production` |
| `HOST`, `PORT` | 로컬 `127.0.0.1:5000`; 컨테이너에서 외부 연결이 필요하면 `HOST=0.0.0.0` |
| `API_PREFIX` | 기본 `api`; 전용 API 도메인에서 prefix가 필요 없으면 빈 문자열 |
| `CORS_ORIGIN_LIST` | 프론트 실제 origin, 기본 `http://localhost:5173` |
| `CORS_CREDENTIALS` | 쿠키 기반 인증을 사용할 때 정책에 맞춰 설정 |
| `RATE_LIMIT_TTL_MS`, `RATE_LIMIT_LIMIT` | 기본 60초당 100회 |
| `TRUST_PROXY_HOPS` | 기본 `0`; 배포 시 실제 신뢰할 프록시 홉 수에 맞춤 |

프론트의 `VITE_API_URL`은 이 서버 주소와 prefix를 합친 값이어야 합니다. 예: `http://localhost:5000/api`. `.env` 변경 후 서버를 다시 시작하세요. DB를 사용하지 않으면 `DB_*`는 예제값으로 두고 다음 단계로 진행할 수 있습니다.

## 4. 실행하고 API 확인

```bash
npm run start:dev
```

소스 변경 시 재빌드·재시작합니다. 별도 터미널에서 기본 설정 기준으로 확인합니다.

```bash
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5000/api/ready
curl http://127.0.0.1:5000/api/samples
```

`health`는 서버 상태, `ready`는 준비 상태를 확인합니다. DB를 연결하지 않은 기본 앱의 readiness는 `database: disabled`입니다. prefix·포트를 변경했다면 확인 URL도 맞춥니다.

오류 응답은 전역 필터가 통일합니다. 요청 로그는 `finish`/`close`에서 한 번 기록하고, 5xx 상세 로그는 같은 요청 ID로 연결합니다. 개발에서는 읽기 쉬운 텍스트, 운영에서는 JSON을 stdout/stderr로 출력합니다. 응답 규칙과 샘플 API는 [API 문서](docs/api/app.md)를 참고하세요.

## 5. PostgreSQL 연결 — 필요한 프로젝트만

로컬 DB를 Docker로 실행하려면 Docker가 실행 중인 상태에서 다음 명령을 사용합니다.

```bash
docker compose up -d postgres
```

제공된 Compose는 `localhost:5432`, 사용자 `dev`, 비밀번호 `devpass`, DB `devdb`로 설정되어 있습니다. 연결 대상이 다르면 `.env`의 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`을 변경합니다. Compose의 계정·DB 값은 파일에 직접 설정되어 있어 서버 `.env`만 바꿔서는 컨테이너 설정이 바뀌지 않습니다.

`src/app.module.ts`에 다음 import를 추가하고 기존 `imports` 배열에 `DatabaseModule`을 포함합니다.

```ts
import { DatabaseModule } from './infra/database/database.module';

// 기존 CoreModule, InfraModule, 기능 모듈과 함께 등록
// imports: [CoreModule, InfraModule, DatabaseModule, SampleModule]
```

다시 시작하면 DB 연결을 검사하며, `/api/ready`도 실제 쿼리로 준비 상태를 확인합니다. 샘플 저장소는 여전히 메모리 방식이므로 실제 기능의 DB repository는 별도로 구현해야 합니다. 스키마·마이그레이션도 프로젝트에 맞게 구성하세요. 운영 DB의 TLS·CA·pool·timeout 값은 `.env.example`의 `DB_*` 설정을 참고합니다.

## 6. 첫 기능 모듈 추가

저장소 루트의 별도 터미널에서 실행합니다.

```bash
./scripts/create-module order orders
```

`server/src/modules/order`가 생성됩니다. 출력 안내에 따라 `OrderModule`을 `src/app.module.ts`에 등록하고 도메인·DTO·저장소를 구현합니다.

| 위치 | 책임 |
|---|---|
| `modules/<feature>/presentation` | Controller·DTO·HTTP 오류 매핑 |
| `modules/<feature>/application` | 유스케이스와 실행 흐름 |
| `modules/<feature>/domain` | 도메인 규칙·엔티티·저장소 계약 |
| `modules/<feature>/infrastructure` | 저장소 등 기술 구현 |
| `core`, `infra`, `config` | 공통 기반·외부 기술 연결·환경 설정 |

성공 결과는 반환하고 오류는 던지는 방식으로 전역 응답 처리를 재사용합니다. 도메인 오류의 HTTP 매핑은 sample 모듈을 참고하세요. 새 기능이 준비되면 `SampleModule`과 샘플 API 문서의 유지 여부를 정리하고, 변경된 API 계약을 문서와 프론트 소비자에 함께 반영합니다.

## 7. 변경 검증과 배포 준비

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

Jest의 SWC 변환은 타입 검사를 대신하지 않으므로 `typecheck`도 실행합니다. 빌드는 TypeScript CLI와 `tsc-alias`를 사용하며 결과는 `dist/`에 생성됩니다. 운영 환경변수를 준비한 뒤 `npm run start:prod`로 빌드 결과를 실행합니다.

DB를 사용한다면 **전용 테스트 DB**의 연결 문자열을 `TEST_DATABASE_URL` 환경변수로 설정하고 `npm run test:db`도 실행합니다. 실제 commit·rollback·timeout 복구를 검사하므로 운영 DB를 대상으로 사용하지 않습니다.

설치 재현에는 `npm ci`를 사용하고 lockfile을 함께 관리합니다. 현재 Multer override는 Nest adapter의 고정 버전을 보완하므로 패키지 업데이트 시 필요성을 다시 확인합니다.

설계·구현 기준은 [NestJS 스킬](../.agents/skills/nestjs-backend-development/SKILL.md), API 변경 기준은 [API 문서 스킬](../.agents/skills/back-api-doc-rules/SKILL.md), 현재 구조의 상세 설명은 [CONVENTION.md](docs/CONVENTION.md)를 참고하세요.
