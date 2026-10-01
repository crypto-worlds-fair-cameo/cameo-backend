# GET /api/auth/me — 현재 사용자 조회

- 상태: 설계 확정, 구현 예정. 현재 제공 중인 API가 아니다.
- 설계 기준일: 2026-10-01
- 공통 정책: [Web3 로그인 설계](../../superpowers/specs/2026-10-01-web3-auth-design.md)
- 경로는 `API_PREFIX=api` 기준이며 경로 접두사를 비우면 `/auth/me`다.

## 목적과 인증

현재 세션의 서비스 사용자와 세션 만료 시각을 조회한다. 프론트가 새로고침 후 로그인 상태를 복원할 때 사용한다. Phantom의 연결 상태만으로 서비스 로그인 상태를 추정하지 않는다.

운영은 `__Host-cameo_session`, 로컬 HTTP는 `cameo_session` 쿠키가 필요하다. Bearer 토큰이나 지갑 주소 쿼리로 인증하지 않는다.

## 요청

| 항목 | 계약 |
| --- | --- |
| 경로 매개변수 | 없음. |
| 본문 / 쿼리 | 사용하지 않음. 전달되어도 무시. |
| 쿠키 | 세션 쿠키 필수. |
| `Origin` | 다른 출처로 보내는 프론트 요청에 브라우저가 자동으로 포함. 허용된 요청 출처에서 CORS 응답을 받을 수 있음. POST 전용 요청 출처 필수 검증은 이 GET에 적용하지 않음. |

```http
GET /api/auth/me
Origin: https://app.example.com
Cookie: __Host-cameo_session=<opaque-session-token>
```

프론트는 `credentials: 'include'`를 사용한다. 새 SIWS 서명은 필요하지 않다.

## 성공 응답

HTTP 200, `Cache-Control: no-store`. [로그인 응답](sign-in.md)의 `data.user`와 `data.session`과 같은 구조다.

```json
{
  "statusCode": 200,
  "success": true,
  "data": {
    "user": {
      "id": "95416ea1-fcf7-4e88-a58d-3e2e88543bc8",
      "displayName": "사용자-a7f29c41",
      "avatarUrl": null,
      "wallets": [
        {
          "chainNamespace": "solana",
          "address": "6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L"
        }
      ]
    },
    "session": {
      "expiresAt": "2026-10-09T03:00:10.000Z",
      "absoluteExpiresAt": "2026-10-31T03:00:10.000Z"
    }
  }
}
```

예시는 10월 1일 생성한 세션을 10월 2일 조회하여 미접속 만료가 연장된 경우다.

`user.id`는 UUID, `displayName`과 `avatarUrl`은 문자열 또는 null이며 필드를 생략하지 않는다. `wallets`는 연결된 지갑 배열이고 원래 주소와 체인을 반환한다. 배열은 생성 시각, 동일 시각이면 지갑 UUID 순으로 정렬한다. 빈 배열도 표현할 수 있다. 두 만료 필드는 UTC ISO 8601 문자열이다. 세션 ID와 토큰·해시를 반환하지 않는다.

## 세션 연장과 쿠키

서버는 토큰 해시로 세션을 찾고 `revoked_at IS NULL`, 미접속·절대 만료가 현재 시각보다 뒤, 사용자 `status=active`인지 확인한다.

인증에 성공한 조회를 활동으로 계산한다. 본문·쿼리는 조회 대상이나 세션 연장 여부에 영향을 주지 않는다. 인증 가드는 세션을 연장하지 않는다. 유스케이스에서 DB 현재 시각을 `last_seen_at`으로 저장하고 `expires_at=min(현재 시각+7일, absolute_expires_at)`로 갱신한다. 응답의 `expiresAt`은 갱신된 값이며 절대 만료는 유지한다.

같은 토큰을 남은 미접속 만료 기간으로 재발급한다. 운영 쿠키는 HttpOnly, Secure, SameSite=Lax, Path=/, Domain 생략이다. 로컬 HTTP는 환경에 맞는 쿠키 이름과 Secure=false를 사용한다.

폐기·만료 확인과 연장은 DB에서 원자적으로 처리한다. 로그아웃과 연장이 경합해도 폐기된 세션을 복구하거나 폐기 시각을 지우지 않는다. DB 저장을 완료한 뒤 사용자와 만료 정보를 반환한다. 이미 만료된 세션은 새 서명 없이 복구하지 않는다.

## 오류 응답

| 상태 / 코드 | 조건 | 공개 메시지 | 쿠키 |
| --- | --- | --- | --- |
| 400 `BadRequestException` | HTTP 요청 파싱 실패(잘못된 JSON 문법 등) | 요청 파싱 오류 메시지 | 변경하지 않음 |
| 401 `AUTH_SESSION_INVALID` | 세션 쿠키 없음·잘못된 형식·세션 없음·폐기·미접속/절대 만료 | `로그인이 필요합니다.` | 세션 쿠키 삭제 |
| 403 `AUTH_USER_UNAVAILABLE` | 세션은 확인되지만 계정이 활성 상태가 아님 | `이 계정으로 로그인할 수 없습니다.` | 세션 쿠키 삭제 |
| 429 `ThrottlerException` | IP 한도 초과 | `ThrottlerException: Too Many Requests` | 변경하지 않음 |
| 500 `INTERNAL_SERVER_ERROR` | DB 등 내부 실패 | `Internal server error` | 변경하지 않음 |

```json
{
  "statusCode": 401,
  "success": false,
  "code": "AUTH_SESSION_INVALID",
  "message": "로그인이 필요합니다.",
  "error": "Unauthorized",
  "traceId": "c9f2ea59-4f07-4b6d-a1b0-eb546ee18265"
}
```

삭제는 동일한 환경의 쿠키 이름과 적용 범위를 사용해 `Max-Age=0`으로 발급한다. 비활성 계정에서 이번 조회는 세션을 연장하지 않으며 서버의 기존 세션 행은 그대로 두고 사용자 상태로 접근을 거절한다. 내부 실패를 미로그인 401로 바꾸지 않는다.

## 완료 검증

- 로그인 쿠키로 사용자 정보가 복원되고 기존 이름·아바타가 유지되는지 확인한다.
- 본문·쿼리가 전달되어도 무시하고 현재 세션의 사용자를 조회하는지 확인한다.
- 활동 시각과 미접속 만료가 갱신되지만 절대 만료를 넘지 않는지 확인한다.
- 두 만료 시각과 정확히 같은 시각, 폐기된 세션, 잘못된 토큰은 401이며 쿠키가 삭제되는지 확인한다.
- 비활성 계정은 403이며 세션을 연장하지 않는지 확인한다.
- 로그아웃과 동시에 요청해도 폐기된 세션이 다시 유효해지지 않는지 확인한다.
- 사용자 정보를 캐시하지 않고 토큰·해시·세션 ID를 노출하지 않는지 확인한다.
