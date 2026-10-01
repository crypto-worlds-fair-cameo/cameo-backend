# POST /api/auth/login — 지갑 로그인

Solana SIWS 서명을 검증하고 로그인 세션을 발급한다. 기존 로그인은 필요하지 않다. [공통 규칙](../app.md)을 따른다.

## 요청

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `Origin` 헤더 | 예 | 허용된 프론트 출처이며 챌린지 발급 출처와 일치. |
| `Content-Type` 헤더 | 예 | `application/json`. charset은 생략하거나 `utf-8`. |
| 챌린지 연결 쿠키 | 예 | [챌린지 발급](challenges.md) 때 받은 쿠키. |
| 세션 쿠키 | 아니오 | 성공 시 제출한 기존 세션을 폐기. 누락·잘못된 형식은 무시. |
| 경로 / 쿼리 | 아니오 | 정의된 입력 없음. 쿼리는 무시. |

본문은 JSON 객체이며 허용 필드만 남겨 검증한다. 모든 필드는 필수 문자열이고 공백 제거·타입 변환을 적용하지 않는다.

| 본문 필드 | 제약 |
| --- | --- |
| `challengeId` | UUID v4. |
| `address` | Base58 32~44자, 디코딩 시 32바이트인 Solana 주소. 대소문자 유지. |
| `signedMessage` | 표준 Base64. 원본은 유효한 UTF-8 1~4096바이트, 인코딩 최대 5464자. |
| `signature` | 표준 Base64 88자. 원본은 Ed25519 서명 64바이트. |

Base64는 필요한 `=` 패딩을 포함하며 Base64url·공백·줄바꿈은 허용하지 않는다. 지갑이 반환한 `account.address`와 원본 `signedMessage`, `signature` 바이트를 사용한다. 메시지를 재구성하지 않는다. SIWS를 지원하는 Solana 지갑은 브랜드와 관계없이 같은 API를 사용한다.

아래 `<...>` 값은 실제 지갑 결과로 바꾼다.

```json
{
  "challengeId": "ed9d2f5c-25d6-4a0d-a53c-cf9640c73ea2",
  "address": "6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L",
  "signedMessage": "<원본 메시지의 Base64>",
  "signature": "<서명의 Base64>"
}
```

## 응답

HTTP 200. 신규 가입과 재로그인은 같은 응답을 반환한다.

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
        { "chainNamespace": "solana", "address": "6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L" }
      ]
    },
    "session": {
      "expiresAt": "2026-10-08T03:00:10.000Z",
      "absoluteExpiresAt": "2026-10-31T03:00:10.000Z"
    }
  }
}
```

| 필드 | 타입 / 의미 |
| --- | --- |
| `user.id` | UUID 문자열. 사용자 ID. |
| `user.displayName` / `user.avatarUrl` | 문자열 또는 null. 필드를 생략하지 않음. |
| `user.wallets` | 연결된 지갑 배열. 생성 시각·ID 순, 빈 배열 가능. |
| `user.wallets[].chainNamespace` / `address` | 문자열. 체인 / 지갑 주소. |
| `session.expiresAt` / `absoluteExpiresAt` | UTC ISO 8601 문자열. 미접속 만료 / 절대 만료. |

- 처음 로그인한 지갑은 계정을 자동 생성한다. 이름은 `사용자-<소문자 16진수 8자>`, 아바타는 null이다. 기존 계정의 프로필은 유지한다.
- 새 지갑은 기존 로그인 계정에 자동 연결하지 않는다.
- 성공 시 챌린지를 소비하고 새 세션 쿠키를 발급하며 연결 쿠키를 삭제한다. 제출한 기존 세션만 폐기한다.
- 세션은 미접속 7일, 최초 발급 후 최대 30일이다.

## 오류

| 상태 | 코드 | 조건 / 메시지 |
| --- | --- | --- |
| 400 | `BadRequestException` | `Content-Type`·본문 누락, 잘못된 매체 타입·charset·필드 형식. 필드 검증 실패는 검증 내용을 메시지로 전달한다. |
| 403 | `AUTH_ORIGIN_NOT_ALLOWED` | 출처 누락·비허용 또는 챌린지와 다른 출처. `허용되지 않은 요청 출처입니다.` |
| 401 | `AUTH_CHALLENGE_INVALID` | 챌린지 없음·만료·사용됨, 연결 쿠키 누락·형식 오류·불일치. `로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.` |
| 401 | `AUTH_SIGNATURE_INVALID` | 메시지·주소·서명 불일치. `지갑 서명을 확인할 수 없습니다.` |
| 403 | `AUTH_USER_UNAVAILABLE` | 정지·탈퇴 계정. `이 계정으로 로그인할 수 없습니다.` 챌린지 소비·연결 쿠키 삭제. |

그 외 오류는 [공통 오류](../app.md#공통-규칙)를 따른다. 로그인 증명은 재사용할 수 없다. 응답 유실·5xx는 [현재 사용자 조회](me.md)로 제출한 지갑의 로그인 여부를 확인하고, 다시 로그인할 때는 새 챌린지와 서명을 사용한다.
