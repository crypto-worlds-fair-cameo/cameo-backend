# Starter HTTP API

기본 prefix는 `/api`다. `API_PREFIX=''`이면 prefix 없이 호출한다. 모든 endpoint는 인증이 없는 공개 샘플이며, 프로세스별 IP 요청 제한(기본 60초 100회)이 적용된다. 인메모리 샘플 변경은 재시작 시 사라진다.

## 공통 계약

성공: `{ "statusCode": 200, "success": true, "data": ... }`.

오류: `{ "statusCode": 400, "success": false, "code": "BadRequestException", "message": "...", "error": "Bad Request", "traceId": "..." }`.

일반 요청에는 서버 생성 `x-request-id` 응답 헤더가 포함되고 오류의 `traceId`와 연결된다. 클라이언트 request ID를 그대로 신뢰하지 않는다. 부트스트랩 미들웨어 이전의 파싱 실패에서는 ID가 생략될 수 있다.

DTO에 없는 body/query 필드는 400이다. 문자열 필드에 숫자·배열·객체를 보내면 자동 문자열 변환 없이 거절한다. 모든 5xx는 공개 `code=INTERNAL_SERVER_ERROR`, `message=Internal server error`, `error=Internal Server Error`로 정리된다.

한도 초과는 429, `code=ThrottlerException`, `message=ThrottlerException: Too Many Requests`이며 `Retry-After`가 포함된다. 응답의 RateLimit 계열 헤더로 한도를 확인할 수 있다. 기본 저장소는 서버 인스턴스마다 독립적이다. GET/HEAD health·ready는 정확한 경로에 한해 API 한도를 소비하지 않으며, 한도 소진 후에도 호출할 수 있다. API prefix가 적용되고 후행 슬래시와 대소문자는 Express 기본 규칙을 따른다. POST 및 유사 경로는 제외하지 않는다. 429도 전역 오류 필터가 공통 오류 응답을 작성하며 traceId는 x-request-id 응답 헤더와 같다.

CORS 기본 origin은 `http://localhost:5173`, credentials는 false다. 허용되지 않은 origin에는 접근 허용 헤더가 없으며 이는 요청 자체를 서버에서 인증하는 기능이 아니다.

## GET /api/health

입력 없음. 200 data: `{ "status": "ok", "timestamp": "2026-09-13T00:00:00.000Z" }`. DB 연결 상태와 독립적인 liveness다.

## GET /api/ready

입력 없음. 200 data: `{ "status": "ok", "database": "disabled" }`. DatabaseModule을 연결하면 실제 DB 쿼리 성공 시 `database: "up"`, 실패 시 503 공통 서버 오류를 반환한다.

## GET /api/system/info

입력 없음. 200 data: `{ "name": "Nest React Boilerplate", "version": "0.0.1", "environment": "development" }`. 값은 환경 설정을 따른다.

## GET /api/samples

선택 query `q: string`. 앞뒤 공백 제거와 소문자 변환 후 name/description에 포함된 샘플을 반환한다. 빈 q는 전체 목록이다. 같은 q를 반복해 배열로 보내거나 알 수 없는 query를 보내면 400이다.

200 data는 아래 항목의 배열이며 일치 항목이 없으면 `[]`다. 정렬·페이지네이션은 제공하지 않는다.

```json
{ "id": "sample_1", "name": "대시보드 카드 예제", "description": "설명", "createdAt": "2026-09-13T00:00:00.000Z" }
```

## GET /api/samples/:id

필수 path `id: string`. 200 data는 샘플 항목이다. 존재하지 않으면 404, `code=NotFoundException`, `message=샘플 항목을 찾을 수 없습니다.`다.

## PATCH /api/samples/:id/name

필수 path `id: string`, JSON body `{ "name": "새 이름" }`. name은 문자열이며 DTO의 최소 길이 2 제약을 적용한다. 저장 전 trim 후에도 2자 이상이어야 한다. 성공 200 data는 변경된 샘플 항목이다. 반복 요청은 해당 이름으로 다시 설정한다.

- 입력 타입·길이·추가 필드 오류: 400 `BadRequestException`.
- trim 후 2자 미만: 400 `DOMAIN_VALIDATION_ERROR`, `이름은 공백을 제외하고 2자 이상이어야 합니다.`.
- 존재하지 않는 id: 404 `NotFoundException`.
