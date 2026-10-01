# POST /api/auth/logout — 현재 세션 로그아웃

- 상태: 설계 확정, 구현 예정. 현재 제공 중인 API가 아니다.
- 설계 기준일: 2026-10-01
- 공통 정책: [Web3 로그인 설계](../../superpowers/specs/2026-10-01-web3-auth-design.md)
- 경로는 `API_PREFIX=api` 기준이며 경로 접두사를 비우면 `/auth/logout`이다.

## 목적과 인증

요청 쿠키가 가리키는 현재 세션을 폐기하고 해당 브라우저의 인증 쿠키를 삭제한다. 같은 사용자의 다른 브라우저 세션은 유지한다. 사용자 계정과 연결된 지갑은 삭제하지 않는다.

유효한 로그인 세션을 요구하지 않는다. 세션이 없거나 이미 만료·폐기되었어도 반복 로그아웃은 성공한다. 허용된 요청 출처 검증은 항상 적용한다.

## 요청

| 항목 | 계약 |
| --- | --- |
| 경로 매개변수 | 없음. |
| 쿼리 | 사용하지 않음. 전달되어도 무시. |
| `Origin` | 필수. 허용된 프론트 요청 출처와 정확히 일치. |
| `Content-Type` | 본문을 생략하면 필요하지 않음. JSON 본문을 보내는 경우 `application/json`. |
| 본문 | 필요하지 않음. 생략 가능하며, 전달되어도 무시. |
| 쿠키 | 현재 세션 쿠키 선택. 브라우저 연결 쿠키도 있으면 함께 삭제. |

```http
POST /api/auth/logout
Origin: https://app.example.com
Content-Type: application/json
Cookie: __Host-cameo_session=<opaque-session-token>

{}
```

프론트는 `credentials: 'include'`를 사용한다. userId, 지갑 주소, 세션 ID를 본문으로 받아 폐기 대상을 선택하지 않는다.

## 처리와 성공 응답

형식이 맞는 세션 토큰이 있으면 해시로 DB 행을 찾아 `revoked_at`을 현재 시각으로 설정한다. 이미 폐기된 행의 기존 `revoked_at`은 유지한다. 만료된 행도 존재하고 아직 폐기되지 않았다면 폐기한다. 세션이 없거나 쿠키 형식이 잘못되면 다른 행을 변경하지 않는다.

HTTP 200, `Cache-Control: no-store`.

```json
{
  "statusCode": 200,
  "success": true,
  "data": {
    "loggedOut": true
  }
}
```

`loggedOut`은 항상 참(true)인 불리언 값이다. 로그아웃은 세션을 연장하거나 새 세션을 만들지 않는다. 유효한 형식의 토큰으로 DB 작업이 필요하면 DB 결과를 확정한 뒤 쿠키를 삭제한다.

## 쿠키

운영 응답은 두 쿠키를 모두 삭제한다.

```http
Set-Cookie: __Host-cameo_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
Set-Cookie: __Host-cameo_auth_binding=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
```

로컬 HTTP는 `cameo_session`과 `cameo_auth_binding` 이름을 사용하고 Secure를 생략한다. Domain은 환경에 관계없이 생략한다. 브라우저 연결 쿠키 삭제 후 남아 있는 챌린지는 동일 브라우저에서도 새 연결값 없이 사용할 수 없다.

이 API는 서비스 세션을 폐기한다. 프론트의 Phantom 연결 해제는 별도로 수행할 수 있으며, 지갑 연결 해제만으로 서버 세션이 폐기됐다고 표시하지 않는다.

## 오류 응답과 재시도

| 상태 / 코드 | 조건 | 공개 메시지 | 쿠키 |
| --- | --- | --- | --- |
| 400 `BadRequestException` | HTTP 요청 파싱 실패(잘못된 JSON 문법 등) | 요청 파싱 오류 메시지 | 변경하지 않음 |
| 403 `AUTH_ORIGIN_NOT_ALLOWED` | 요청 출처 누락·null·비허용 값 | `허용되지 않은 요청 출처입니다.` | 변경하지 않음 |
| 429 `ThrottlerException` | IP 한도 초과 | `ThrottlerException: Too Many Requests` | 변경하지 않음 |
| 500 `INTERNAL_SERVER_ERROR` | DB 폐기를 확정할 수 없는 내부 실패 | `Internal server error` | 변경하지 않음 |

```json
{
  "statusCode": 500,
  "success": false,
  "code": "INTERNAL_SERVER_ERROR",
  "message": "Internal server error",
  "error": "Internal Server Error",
  "traceId": "c9f2ea59-4f07-4b6d-a1b0-eb546ee18265"
}
```

세션 없음·잘못된 쿠키·만료·이미 폐기는 401이 아닌 200이다. 본문·쿼리는 폐기 대상이나 성공 여부에 영향을 주지 않는다. 요청 출처 검증이나 요청 파싱 실패를 멱등 성공으로 바꾸지 않는다. DB 실패를 성공으로 표시하지 않는다.

반복 요청은 같은 최종 상태를 유지한다. 응답 유실 시 동일 요청을 재시도할 수 있다. 로그아웃과 인증 요청이 경합해도 폐기된 DB 행을 되살리지 않으며, 늦게 도착한 쿠키가 브라우저에 남더라도 해당 토큰은 인증에 실패한다.

## 완료 검증

- 현재 세션이 폐기되고 두 쿠키가 동일 적용 범위로 삭제되는지 확인한다.
- 다른 브라우저 세션과 사용자·지갑 행을 유지하는지 확인한다.
- 세션 없음·잘못된 쿠키·만료·이미 폐기된 경우 200인지 확인한다.
- 본문·쿼리를 생략하거나 추가로 전달해도 현재 쿠키가 가리키는 세션만 폐기하는지 확인한다.
- 반복 로그아웃이 최초 폐기 시각을 바꾸지 않는지 확인한다.
- 비허용 요청 출처에서는 폐기·쿠키 삭제가 발생하지 않고 DB 실패는 성공으로 표시되지 않는지 확인한다.
- 세션 연장과 경합하더라도 로그아웃된 토큰이 다시 인증되지 않는지 확인한다.
