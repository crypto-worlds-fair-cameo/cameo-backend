# POST /api/auth/challenges — 로그인 챌린지 발급

- 상태: 구현 완료. 구현 당시 HTTP·PostgreSQL 통합 검증을 마쳤으며, 검증용 테스트 코드는 저장소에서 제거했다.
- 설계 기준일: 2026-10-01
- 경로는 `API_PREFIX=api` 기준이며 경로 접두사를 비우면 `/auth/challenges`다.

## 목적과 인증

Solana SIWS를 지원하는 지갑이 서명할 입력과 5분짜리 챌린지를 발급한다. Phantom은 첫 프론트 연결·검증 대상이다. 로그인 세션은 필요하지 않다. 발급만으로 사용자·지갑·세션을 생성하거나 로그인 상태를 바꾸지 않는다.

## 지갑 지원과 확장 기준

챌린지는 지갑 앱 이름에 종속되지 않는다. 현재 SIWS 계약을 지원하는 Solana 지갑은 같은 발급 API와 [로그인 API](login.md)를 사용한다. 서버는 지갑 브랜드를 입력으로 받거나 브랜드별 챌린지를 발급하지 않는다. 프론트는 선택한 지갑의 SIWS 지원 여부를 확인하고 연결·서명 호출을 담당한다.

현재 발급 구현은 `auth_method=siws`, Solana `chainId=mainnet`으로 고정되어 있다. 본문·쿼리로 `wallet`, `provider`, `authMethod`, `chainNamespace` 등을 보내도 무시하며 발급 방식을 변경하지 않는다. 다른 체인이나 인증 방식을 추가하려면 발급·검증 구현과 공개 API 계약을 별도로 확장한다. `auth_method`와 `verification_payload`는 그때 활용할 저장 구조이며, 현재 다른 방식을 지원하는 것은 아니다.

SIWS 입력 생성과 저장 책임을 분리했다. 내부 저장 모델은 `authMethod + verificationPayload`이며, 이 API의 요청·응답·쿠키 계약은 유지한다.

## 요청

| 항목 | 계약 |
| --- | --- |
| 경로 매개변수 | 없음. |
| 쿼리 | 사용하지 않음. 전달되어도 무시. |
| `Origin` | 필수. 설정된 프론트 요청 출처와 정확히 일치. |
| `Content-Type` | 본문을 생략하면 필요하지 않음. JSON 본문을 보내는 경우 `application/json`. |
| 본문 | 필요하지 않음. 생략 가능하며, 전달되어도 무시. |
| 쿠키 | 브라우저 연결 쿠키 선택. 유효한 기존 값은 재사용하고 없거나 형식이 잘못되면 새로 생성. 로그인 쿠키는 사용하지 않음. |

```http
POST /api/auth/challenges
Origin: https://app.example.com
Content-Type: application/json

{}
```

프론트의 요청 함수는 `credentials: 'include'`를 지정한다. 쿠키 원문을 JavaScript에서 읽거나 본문에 실어 보내지 않는다.

본문을 보내지 않는 호출 예시는 다음과 같다. `Origin`은 `CORS_ORIGIN_LIST`의 프론트 출처와 일치해야 한다.

```bash
curl -i -X POST http://localhost:5000/api/auth/challenges \
  -H 'Origin: http://localhost:5173' \
  -c /tmp/cameo-auth-cookies.txt
```

## 성공 응답

HTTP 201, `Cache-Control: no-store`.

```json
{
  "statusCode": 201,
  "success": true,
  "data": {
    "challengeId": "ed9d2f5c-25d6-4a0d-a53c-cf9640c73ea2",
    "signInInput": {
      "domain": "app.example.com",
      "statement": "Sign in to Cameo.",
      "uri": "https://app.example.com/",
      "version": "1",
      "chainId": "mainnet",
      "nonce": "b714af45ce3991d8f0205aee974c268a2ad51da6b020685084b97c4e23fd9ad7",
      "issuedAt": "2026-10-01T03:00:00.000Z",
      "expirationTime": "2026-10-01T03:05:00.000Z",
      "requestId": "ed9d2f5c-25d6-4a0d-a53c-cf9640c73ea2"
    }
  }
}
```

예시는 형식 확인용이다. 실제 호출은 그 시점에 발급받은 챌린지를 사용한다.

| 필드 | 타입과 의미 |
| --- | --- |
| `challengeId` | UUID v4 문자열. 서버의 챌린지 ID. |
| `signInInput` | 모든 아래 필드가 있는 객체. null·생략 없음. 선택한 SIWS 호환 지갑의 `signIn` 입력으로 그대로 전달. |
| `domain` | 허용된 프론트 요청 출처의 호스트. 로컬은 포트를 포함한 `localhost:5173`. |
| `statement` | 고정 문자열 `Sign in to Cameo.` |
| `uri` | 허용된 요청 출처에 `/`를 붙인 루트 URI. |
| `version` / `chainId` | 각각 문자열 `1`, `mainnet`. |
| `nonce` | 난수 32바이트를 표현한 소문자 16진수 64자. |
| `issuedAt` / `expirationTime` | UTC ISO 8601 문자열. DB 생성 시각과 정확히 5분 뒤 만료 시각. |
| `requestId` | `challengeId`와 같은 UUID 문자열. |

`address`, `notBefore`, `resources`는 발급하지 않는다. 서명 주소는 지갑이 선택하며 로그인 검증에서 메시지·공개키·제출 주소의 일치를 확인한다.

## 쿠키

운영은 `__Host-cameo_auth_binding`, 로컬 HTTP는 `cameo_auth_binding`을 발급한다. 값은 난수 32바이트의 패딩 없는 Base64url 43자다.

```http
Set-Cookie: __Host-cameo_auth_binding=<opaque-binding>; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax
```

`<opaque-binding>`은 문서상의 쿠키 값 표기이며 실제 토큰이 아니다. 운영은 Domain을 생략하여 API 호스트에만 발급하고, 로컬 HTTP는 Secure를 생략한다. 새 챌린지를 발급할 때 연결 쿠키의 수명을 300초로 다시 설정한다. 쿠키 해시만 DB에 저장한다. DB 커밋에 실패하면 쿠키를 발급하지 않는다.

## 저장과 재시도

`auth_challenges`에 `auth_method=siws`, nonce, 발급 SIWS 입력 전체, 브라우저 연결값 해시, 생성·만료 시각을 저장한다. `consumed_at`은 null이다.

반복 호출은 다른 챌린지를 발급하며 멱등 요청이 아니다. 기존 연결 쿠키가 있으면 앞서 발급한 미사용 챌린지를 바로 무효화하지 않는다. 최초 쿠키가 없는 여러 탭에서 동시에 발급하면 마지막 응답의 쿠키가 적용될 수 있으므로, 연결값이 맞지 않는 챌린지는 새로 발급받는다.

## 오류 응답

| 상태 / 코드 | 조건 | 공개 메시지 |
| --- | --- | --- |
| 400 `BadRequestException` | HTTP 요청 파싱 실패(잘못된 JSON 문법 등) | 요청 파싱 오류 메시지 |
| 403 `AUTH_ORIGIN_NOT_ALLOWED` | 요청 출처 누락·null·비허용 값 | `허용되지 않은 요청 출처입니다.` |
| 429 `ThrottlerException` | 기존 프로세스별 IP 한도 초과 | `ThrottlerException: Too Many Requests` |
| 500 `INTERNAL_SERVER_ERROR` | DB 등 내부 실패 | `Internal server error` |

```json
{
  "statusCode": 403,
  "success": false,
  "code": "AUTH_ORIGIN_NOT_ALLOWED",
  "message": "허용되지 않은 요청 출처입니다.",
  "error": "Forbidden",
  "traceId": "c9f2ea59-4f07-4b6d-a1b0-eb546ee18265"
}
```

429에는 `Retry-After`가 포함된다. 오류도 `Cache-Control: no-store`를 사용한다. 이 API의 실패는 기존 로그인 세션을 폐기하지 않는다.

## 완료 검증

- 유효한 요청 출처에서 201과 연결 쿠키를 받고, DB 검증용 입력이 응답 SIWS 입력과 같은지 확인한다.
- nonce가 재발급마다 달라지고, requestId=challengeId, 만료=생성+5분인지 확인한다.
- 기존 연결 쿠키 재사용, 없는 쿠키 생성, 잘못된 쿠키 교체를 확인한다.
- 본문·쿼리를 생략하거나 추가로 전달해도 무시하고 정상 발급하는지 확인한다. 해당 입력으로 SIWS 발급 값을 변경하거나 사용자·지갑·세션 행을 생성하지 않는다.
- 지갑 브랜드를 전달하지 않아도 발급되며, `wallet`, `provider`, `authMethod`, `chainNamespace` 등 추가 입력이 발급 방식·체인·검증용 입력에 영향을 주지 않는지 확인한다.
- 잘못된 요청 출처는 거절하며 신규 챌린지가 생성되지 않는지 확인한다.
- DB 실패 시 신규 챌린지와 쿠키가 발급되지 않는지 확인한다.
