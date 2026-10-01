# HTTP API

기본 경로 접두사는 `/api`다. `API_PREFIX=''`이면 `/api`를 제외한다.

| 메서드 | 경로 | 문서 |
| --- | --- | --- |
| POST | `/api/auth/challenges` | [로그인 챌린지 발급](auth/challenges.md) |
| POST | `/api/auth/login` | [지갑 로그인](auth/login.md) |
| GET | `/api/auth/me` | [현재 사용자 조회](auth/me.md) |
| POST | `/api/auth/logout` | [로그아웃](auth/logout.md) |

## 공통 규칙

- 정의되지 않은 쿼리는 무시한다. 본문은 허용 필드만 남겨 검증한다. 입력이 없는 API는 본문·쿼리를 무시한다.
- 허용 필드의 타입을 자동 변환하지 않는다. 잘못된 JSON 등 HTTP 파싱 오류는 입력을 사용하지 않는 API에서도 거절한다.
- 날짜는 UTC ISO 8601 문자열이다.
- 성공 응답은 `statusCode`, `success: true`, `data`를 반환한다.
- 오류의 `traceId`는 응답 헤더 `x-request-id`와 같다. 초기 파싱 오류에서는 생략될 수 있다.

```json
{
  "statusCode": 400,
  "success": false,
  "code": "BadRequestException",
  "message": "challengeId must be a UUID",
  "traceId": "c9f2ea59-4f07-4b6d-a1b0-eb546ee18265"
}
```

| 상태 | 코드 | 조건 / 메시지 |
| --- | --- | --- |
| 400 | `BadRequestException` | 입력 검증·파싱 실패. Nest 예외의 메시지를 전달하며, 검증 메시지 배열은 쉼표로 합친 문자열이다. 로그인 매체 타입·charset 오류는 `요청 형식이 올바르지 않습니다.`. |
| 413 | `PayloadTooLargeException` | 본문 크기 등 파서 제한 초과. `요청 본문이 너무 큽니다.` |
| 415 | `UnsupportedMediaTypeException` | 지원하지 않는 본문 인코딩. `지원하지 않는 본문 인코딩입니다.` |
| 429 | `ThrottlerException` | 요청 제한 초과. `ThrottlerException: Too Many Requests`. `Retry-After` 제공. |
| 5xx | `INTERNAL_SERVER_ERROR` | 서버 오류. `Internal server error`. |

기본 요청 제한은 IP당 60초에 100회다. GET/HEAD `/health`, `/ready`는 제외한다.

## 인증 공통 규칙

- 프론트 요청은 `credentials: 'include'`를 사용한다. CORS 기본 출처는 `http://localhost:5173`이다.
- 인증 POST 요청은 `Origin`이 필수이며 `CORS_ORIGIN_LIST`의 출처와 정확히 일치해야 한다.
- 인증 API의 성공·오류 응답은 `Cache-Control: no-store`를 사용한다.
- 인증 쿠키는 `HttpOnly`, `SameSite=Lax`, `Path=/`, Domain 생략이다. 운영은 `Secure`를 적용한다.
- 같은 이름의 쿠키가 중복되면 미제출로 처리한다. 쿠키 값은 서버가 관리하며 JSON으로 반환하지 않는다.

| 역할 | 운영 (`NODE_ENV=production`) | 로컬 |
| --- | --- | --- |
| 챌린지 연결 | `__Host-cameo_auth_binding` | `cameo_auth_binding` |
| 로그인 세션 | `__Host-cameo_session` | `cameo_session` |

## GET /api/health

인증·입력 없음. 서버 실행 상태를 반환한다. HTTP 200:

```json
{ "statusCode": 200, "success": true, "data": { "status": "ok", "timestamp": "2026-10-01T03:00:00.000Z" } }
```

## GET /api/ready

인증·입력 없음. DB 연결을 확인한다. `database`는 `up` 또는 DB 비활성 시 `disabled`다. 실패하면 503 `INTERNAL_SERVER_ERROR`. HTTP 200:

```json
{ "statusCode": 200, "success": true, "data": { "status": "ok", "database": "up" } }
```

## GET /api/system/info

인증·입력 없음. 환경 설정의 서버 정보를 반환한다. HTTP 200:

```json
{ "statusCode": 200, "success": true, "data": { "name": "Nest React Boilerplate", "version": "0.0.1", "environment": "development" } }
```

## GET /api/samples

인증 없음. 선택 쿼리 `q: string`을 공백 제거·소문자 변환 후 이름·설명에서 검색한다. 빈 값이면 전체, 일치 항목이 없으면 `[]`다. `q`에 배열 등 문자열이 아닌 값을 보내면 400이다. 생성 시각 오름차순이며 페이지네이션은 없다. HTTP 200:

```json
{ "statusCode": 200, "success": true, "data": [{ "id": "sample_1", "name": "대시보드 카드 예제", "description": "설명", "createdAt": "2026-10-01T03:00:00.000Z" }] }
```

샘플의 `id`, `name`, `description`, `createdAt`은 문자열이다. 샘플 변경은 서버 재시작 시 초기화된다.

## GET /api/samples/:id

인증 없음. 필수 경로 `id: string`. HTTP 200의 `data`는 위 샘플 객체다. 없으면 404 `SAMPLE_NOT_FOUND`, `샘플 항목을 찾을 수 없습니다.`.

## PATCH /api/samples/:id/name

인증 없음. 필수 경로 `id: string`, JSON 본문 `{ "name": "새 이름" }`. `name`은 필수 문자열이며 공백 제거 후에도 2자 이상이어야 한다. HTTP 200의 `data`는 변경된 샘플 객체다.

- 입력 타입·길이 오류: 400 `BadRequestException`.
- 공백 제거 후 2자 미만: 400 `SAMPLE_INVALID_NAME`, `이름은 공백을 제외하고 2자 이상이어야 합니다.`.
- 없는 ID: 404 `SAMPLE_NOT_FOUND`, `샘플 항목을 찾을 수 없습니다.`.
