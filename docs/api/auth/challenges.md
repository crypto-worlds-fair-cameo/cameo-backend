# POST /api/auth/challenges — 로그인 챌린지 발급

Solana SIWS 지갑의 서명 입력을 발급한다. 로그인 세션은 필요하지 않다. [공통 규칙](../app.md)을 따른다.

## 요청

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `Origin` 헤더 | 예 | 허용된 프론트 출처. |
| 챌린지 연결 쿠키 | 아니오 | 유효한 값은 재사용하고, 없거나 잘못되면 새로 발급. |
| 경로 / 쿼리 / 본문 | 아니오 | 정의된 입력 없음. 본문·쿼리는 무시. |

본문과 `Content-Type`은 생략할 수 있다.

```http
POST /api/auth/challenges
Origin: https://app.example.com
```

## 응답

HTTP 201. `challengeId`는 UUID v4이며 `signInInput`의 모든 필드는 문자열이다.

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

| 필드 | 의미 |
| --- | --- |
| `domain` / `uri` | 요청 출처의 호스트(포트 포함) / 루트 URI. |
| `statement` / `version` / `chainId` | 각각 `Sign in to Cameo.`, `1`, `mainnet`. |
| `nonce` | 임의의 소문자 16진수 64자. |
| `issuedAt` / `expirationTime` | 발급 시각 / 5분 뒤 만료 시각. |
| `requestId` | `challengeId`와 동일. |

`signInInput`을 지갑의 `solana:signIn`에 그대로 전달하고 결과를 [로그인 API](login.md)에 제출한다. 지갑 브랜드 입력은 필요하지 않다.

- 챌린지 연결 쿠키를 300초로 설정한다. 기존 로그인 세션은 변경하지 않는다.
- 호출할 때마다 새 챌린지를 발급하며, 각 챌린지는 로그인에 한 번만 사용할 수 있다.

## 오류

| 상태 | 코드 | 조건 / 메시지 |
| --- | --- | --- |
| 403 | `AUTH_ORIGIN_NOT_ALLOWED` | 출처 누락·비허용. `허용되지 않은 요청 출처입니다.` |

그 외 오류는 [공통 오류](../app.md#공통-규칙)를 따른다.
