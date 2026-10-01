# POST /api/auth/login — 지갑 로그인

- 상태: 설계 확정, 구현 예정. 현재 제공 중인 API가 아니다.
- 설계 기준일: 2026-10-01
- 경로는 `API_PREFIX=api` 기준이며 경로 접두사를 비우면 `/auth/login`이다.

## 목적과 인증

[챌린지 발급](challenges.md)에서 받은 입력에 대한 Solana SIWS 서명을 검증한다. 로그인 세션 없이 호출할 수 있으나 챌린지를 발급받은 브라우저의 연결 쿠키가 필요하다. 기존 로그인 쿠키가 있어도 새 지갑 증명을 검증하며, 성공할 때 해당 브라우저의 기존 세션을 교체한다.

Phantom은 첫 프론트 연결·검증 대상이다. 서버의 지원 기준은 지갑 브랜드가 아니라 Solana SIWS 메시지와 Ed25519 서명이다. 현재 계약에 맞는 증명을 반환하는 다른 Solana 지갑도 같은 API를 사용한다. 같은 Solana 주소로 다른 지갑 앱에서 로그인해도 기존 계정을 사용한다.

서버는 지갑 앱 이름이나 `isPhantom` 주장으로 신원을 판단하지 않는다. 프론트는 선택한 지갑의 `solana:signIn` 등 SIWS 기능 지원 여부를 확인하고, 지갑별 연결·서명 호출을 담당한다. HTTP API 이름은 `login`이며 Wallet Standard의 `signIn`과 챌린지 응답의 `signInInput`은 표준 연동에 사용하는 이름으로 유지한다.

## 지갑 확장과 구현 경계

- `login/`은 챌린지 확인·소비, 계정 확인·생성, 세션 발급과 트랜잭션을 조정한다. Phantom SDK나 지갑 브랜드 분기를 넣지 않는다.
- `siws/`는 Solana SIWS 입력 생성·메시지·주소·서명 검증을 담당한다. 검증에 성공하면 `chainNamespace`, `address`, `addressKey`로 구성된 검증된 지갑 정보를 로그인 흐름에 전달한다. 현재 값은 `solana`, 검증한 주소, 같은 주소다.
- `wallet-account/`는 검증된 `(chainNamespace, addressKey)`로 계정을 찾고, `session/`은 서비스 세션을 처리한다. 지갑 앱 이름은 계정 식별자에 포함하지 않는다.
- 검증 방식은 DB에 저장된 챌린지의 `auth_method`로 결정한다. 현재는 `siws`만 지원하며, 클라이언트가 보낸 `wallet`, `provider`, `authMethod`, `chainNamespace` 등 추가 필드는 제거하고 검증 방식이나 체인을 바꾸는 데 사용하지 않는다.
- 같은 SIWS 계약을 지원하는 지갑 추가는 프론트 연결 구현과 호환성 검증으로 진행한다. 다른 체인이나 인증 방식은 해당 방식의 발급·검증 구현과 공개 API 계약을 별도로 확장해야 한다. 현재 Base58 주소·Ed25519·SIWS 입력 계약이 모든 체인을 지원한다는 의미는 아니다.

위 경계는 후속 로그인 구현 기준이다. SIWS 타입·입력 생성·저장 경계를 분리했다. 현재 `siws/`는 타입·입력 생성을 구현했고, 로그인 구현에서 같은 책임에 증명 검증을 추가한다. 발급과 검증 대상은 계속 SIWS이며 로그인 API 자체는 아직 구현하지 않았다.

## 계정 생성 정책

- 처음 검증된 지갑이면 별도 가입 절차 없이 `users`와 `user_wallets`를 함께 생성한다.
- 새 계정의 `displayName`은 암호학적 난수 4바이트의 소문자 16진수를 붙인 `사용자-a7f29c41` 형식이다. 이름 중복을 허용하며 사용자 식별은 `users.id`로 한다. `avatarUrl`은 null이다.
- 검증된 `(chainNamespace, addressKey)`로 기존 계정을 찾는다. Solana는 주소 대소문자를 유지하고 `addressKey=address`로 저장한다. 기존 계정의 이름과 아바타는 유지한다.
- `status=active`인 계정만 로그인한다. `suspended`와 `withdrawn`은 거절하며 계정을 다시 생성하거나 지갑을 다른 계정으로 옮기지 않는다.
- 새 지갑과 기존 로그인 쿠키를 함께 제출해도 기존 계정에 자동 연결하지 않는다. 지갑 연결·계정 병합·프로필 수정은 별도 API의 범위다.

## 요청

필수 헤더는 `Origin`과 `Content-Type: application/json`이다. 요청 출처는 허용 목록과 챌린지에 저장된 URI의 요청 출처에 모두 일치해야 한다. 정의된 쿼리가 없으므로 전달된 쿼리는 모두 무시한다. 본문은 필수이며 아래 허용 필드만 남긴 뒤 검증한다. 정의되지 않은 본문 필드는 제거하고, 그 존재만으로 400을 반환하지 않는다. 프론트 요청은 `credentials: 'include'`를 사용한다.

| 본문 필드 | 타입 | 필수 | 검증 |
| --- | --- | --- | --- |
| `challengeId` | 문자열 | 예 | UUID v4. |
| `address` | 문자열 | 예 | Base58 32~44자, 디코딩 결과 32바이트. 대소문자 유지, 공백 거절. |
| `signedMessage` | 문자열 | 예 | 패딩을 포함한 표준 Base64. UTF-8 원본 메시지 1~4096바이트, 인코딩 문자열 최대 5464자. |
| `signature` | 문자열 | 예 | 패딩을 포함한 표준 Base64, 정확히 64바이트를 표현한 88자. Ed25519로 검증. |

허용 필드의 값에는 Base64url, 공백·줄바꿈이 섞인 Base64, 숫자 배열, null, 암묵적 문자열 변환을 허용하지 않는다. Base64는 재인코딩하여 같은 문자열인지 확인한다. `signInInput`, nonce, domain, chainId, publicKey 등 정의되지 않은 필드는 제출되어도 제거하고 사용하지 않는다. 서명 검증의 기대 입력은 서버에 저장된 챌린지에서 읽는다.

서명 결과의 실제 `account.address`를 `address`로 전달한다. `signedMessage`와 `signature`는 지갑이 반환한 Uint8Array를 그대로 Base64로 인코딩한다. 메시지를 TextEncoder로 다시 구성하지 않는다.

```json
{
  "challengeId": "ed9d2f5c-25d6-4a0d-a53c-cf9640c73ea2",
  "address": "6xtn9dTbszpUkeqsgaU4oQwSXBPFkGUHdQTaG2Zeoc8L",
  "signedMessage": "YXBwLmV4YW1wbGUuY29tIHdhbnRzIHlvdSB0byBzaWduIGluIHdpdGggeW91ciBTb2xhbmEgYWNjb3VudDoKNnh0bjlkVGJzenBVa2Vxc2dhVTRvUXdTWEJQRmtHVUhkUVRhRzJaZW9jOEwKClNpZ24gaW4gdG8gQ2FtZW8uCgpVUkk6IGh0dHBzOi8vYXBwLmV4YW1wbGUuY29tLwpWZXJzaW9uOiAxCkNoYWluIElEOiBtYWlubmV0Ck5vbmNlOiBiNzE0YWY0NWNlMzk5MWQ4ZjAyMDVhZWU5NzRjMjY4YTJhZDUxZGE2YjAyMDY4NTA4NGI5N2M0ZTIzZmQ5YWQ3Cklzc3VlZCBBdDogMjAyNi0xMC0wMVQwMzowMDowMC4wMDBaCkV4cGlyYXRpb24gVGltZTogMjAyNi0xMC0wMVQwMzowNTowMC4wMDBaClJlcXVlc3QgSUQ6IGVkOWQyZjVjLTI1ZDYtNGEwZC1hNTNjLWNmOTY0MGM3M2VhMg==",
  "signature": "9qegQmkTnic2LISB21EFpBbFhxKuHQKzOGCr438W0kKEauzAYMxQXjo5jJuUdEv4ma6A/lwMLQOFbz4Q6BGhDw=="
}
```

예시는 임시 테스트 키로 서명한 형식 확인용 데이터이며 실제 사용자 지갑이 아니다. 실제 API는 서버가 발급한 미사용·미만료 챌린지와 해당 브라우저의 연결 쿠키를 요구한다.

## 검증 순서

1. 정의되지 않은 쿼리를 무시하고 본문에서 허용 필드만 남긴 뒤 DTO, 허용 요청 출처, 브라우저 연결 쿠키 형식을 검증한다.
2. `challengeId`로 서버에 저장된 행을 읽고 존재, `auth_method=siws`, 미사용, 유효기간과 연결값 해시 일치를 확인한다.
3. SIWS 검증에서 저장된 입력과 제출 주소로 기대 메시지를 구성하고 모든 필드와 서명 대상 바이트 일치, 공개키와 Ed25519 서명을 확인한다. 검증된 지갑 정보를 다음 처리에 전달한다.
4. DB 트랜잭션 안에서 동일 `(chainNamespace, addressKey)`의 로그인을 직렬화하고 유효기간·미사용을 조건부 갱신으로 다시 확인하여 소비한다.
5. 검증된 지갑의 체인·주소 키로 기존 지갑을 확인하고 처음이면 계정과 지갑을 만든다. 활성 계정의 로그인 시각을 갱신하고 새 세션을 생성한다.
6. 제출된 기존 로그인 쿠키가 가리키는 세션만 폐기하여 커밋하고 성공 쿠키와 응답을 반환한다.

잘못된 서명은 챌린지를 소비하지 않는다. 유효한 서명이지만 정지 또는 탈퇴한 계정이면 챌린지 소비만 커밋하고 403을 반환한다. DB 실패는 전체를 롤백한다. HTTP 응답을 전송하지 못해도 완료된 커밋은 되돌리지 않는다.

같은 지갑의 최초 로그인은 트랜잭션 자문 잠금과 `(chain_namespace, address_key)` 유일 제약을 함께 사용한다. 경합이나 제약 실패 시 사용자 생성도 롤백하여 고아 계정을 남기지 않는다. 사용자·지갑의 `updated_at`, `last_login_at`, `last_used_at`은 갱신 트리거에 의존하지 않고 해당 변경에서 명시적으로 갱신한다.

## 성공 응답

HTTP 200, `Cache-Control: no-store`. 신규 가입과 재로그인 모두 같은 계약이다.

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
      "expiresAt": "2026-10-08T03:00:10.000Z",
      "absoluteExpiresAt": "2026-10-31T03:00:10.000Z"
    }
  }
}
```

| 필드 | 타입과 의미 |
| --- | --- |
| `user.id` | UUID 문자열. 서비스 사용자 ID. |
| `user.displayName` | 문자열 또는 null. 새 계정은 자동 생성된 이름. 기존의 null을 허용하는 데이터는 그대로 표현. |
| `user.avatarUrl` | 문자열 또는 null. 새 계정은 null. |
| `user.wallets` | 연결된 지갑 배열. 생성 시각, 동일 시각이면 지갑 UUID 순으로 정렬. |
| `wallets[].chainNamespace` / `address` | 문자열. 현재 새로 연결하는 체인은 `solana`. 주소는 저장된 대소문자 유지. |
| `session.expiresAt` | UTC ISO 8601 문자열. 현재 미접속 만료. |
| `session.absoluteExpiresAt` | UTC ISO 8601 문자열. 새 세션 생성 시각+30일. |

null은 필드를 생략하는 의미가 아니다. 세션 ID, 토큰, 토큰 해시, 브라우저 연결값, DB 내부 상태는 응답하지 않는다. 실제 로그인에 사용한 지갑 선택 상태는 프론트가 지갑 결과에서 유지한다.

## 쿠키와 부수 효과

운영은 새 `__Host-cameo_session`, 로컬 HTTP는 새 `cameo_session`을 발급한다. 기존 브라우저 토큰을 새 세션의 토큰으로 재사용하지 않는다.

운영 프론트와 API는 같은 최상위 도메인의 서브도메인으로 분리하고 양쪽 HTTPS를 사용한다. 세션 생성 시 DB 시각을 기준으로 미접속 만료는 7일, 절대 만료는 30일 뒤다. 쿠키의 `Max-Age`는 DB 만료까지 남은 초를 올림하여 설정하며 실제 허용 여부는 DB 만료로 판단한다. 이후 활동에 따른 연장은 [현재 사용자 API](me.md)의 계약을 따른다.

```http
Set-Cookie: __Host-cameo_session=<opaque-session-token>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
Set-Cookie: __Host-cameo_auth_binding=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
```

운영은 Domain을 생략하고 로컬은 Secure를 생략한다. `<opaque-session-token>`은 설명용 표기다. 세션 토큰은 랜덤 32바이트의 Base64url 43자이며 SHA-256 해시만 DB에 저장한다.

성공 시 챌린지를 소비하고 연결 쿠키를 삭제한다. 비활성 계정으로 소비만 커밋한 403에서도 연결 쿠키를 삭제하되 기존 로그인 쿠키와 세션은 유지한다. 다른 브라우저의 세션은 폐기하지 않는다. 동일 지갑으로 반복 로그인해도 계정·지갑을 추가 생성하거나 이름을 바꾸지 않는다.

## 오류 응답과 재시도

| 상태 / 코드 | 조건 | 공개 메시지 | 소비자가 할 일 |
| --- | --- | --- | --- |
| 400 `BadRequestException` | 본문·필수 필드 누락, 허용 필드의 타입·주소·Base64 형식 오류 또는 요청 파싱 실패 | 입력 검증 결과 또는 요청 파싱 오류 메시지 | 요청 구성 수정 |
| 403 `AUTH_ORIGIN_NOT_ALLOWED` | 요청 출처 누락·비허용·챌린지 요청 출처 불일치 | `허용되지 않은 요청 출처입니다.` | 프론트/API 설정 확인 |
| 401 `AUTH_CHALLENGE_INVALID` | 챌린지 없음·잘못된 방식·만료·이미 사용·연결 쿠키 없음/불일치 | `로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.` | 새 챌린지로 다시 서명 |
| 401 `AUTH_SIGNATURE_INVALID` | 형식은 맞지만 서명·메시지·주소가 불일치 | `지갑 서명을 확인할 수 없습니다.` | 전송 바이트 확인 후 유효한 챌린지에 다시 서명 |
| 403 `AUTH_USER_UNAVAILABLE` | 계정이 활성 상태가 아님 | `이 계정으로 로그인할 수 없습니다.` | 자동 가입 반복 금지 |
| 429 `ThrottlerException` | IP 한도 초과 | `ThrottlerException: Too Many Requests` | `Retry-After` 이후 재시도 |
| 500 `INTERNAL_SERVER_ERROR` | DB 등 내부 실패 | `Internal server error` | 현재 세션 확인 후 새 로그인 시도 |

```json
{
  "statusCode": 401,
  "success": false,
  "code": "AUTH_CHALLENGE_INVALID",
  "message": "로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.",
  "error": "Unauthorized",
  "traceId": "c9f2ea59-4f07-4b6d-a1b0-eb546ee18265"
}
```

로그인은 동일 서명 증명을 재전송하는 멱등 API가 아니다. 응답 유실 시 먼저 [현재 사용자 API](me.md)를 호출한다. 세션 쿠키가 저장되었다면 결과를 사용하고, 401이면 새 챌린지와 새 서명으로 로그인한다.

지갑 미설치, 사용자의 승인 취소, `signIn` 미지원은 프론트/지갑 오류다. 서버 로그인 API의 업무 오류 코드로 가장하지 않으며, 검증되지 않은 연결 상태만으로 로그인 성공 UI를 표시하지 않는다.

## 완료 검증

- 실제 Phantom 서명으로 계정·지갑·세션과 쿠키가 생성되고 재로그인 시 기존 ID·이름을 유지하는지 확인한다.
- 같은 형식의 유효한 SIWS 증명은 지갑 브랜드 필드 없이 검증되는지 확인한다. `wallet`, `provider`, `isPhantom` 등의 추가 필드는 제거되며 성공·실패 판단에 영향을 주지 않아야 한다.
- 다른 지갑 앱에서 같은 Solana 주소의 증명을 제출해도 기존 ID·이름을 유지하는지 확인한다. 실제 추가 지갑의 지원 상태는 해당 지갑으로 호환성을 확인한 뒤 기록한다.
- 추가 쿼리를 무시하고, 본문의 추가 필드를 제거한 뒤 유효한 허용 필드로 로그인하는지 확인한다. 제거한 `signInInput`, nonce, domain 등의 값이 서명 검증이나 계정 생성에 영향을 주지 않는지 확인한다.
- 본문·필수 필드 누락과 허용 필드의 잘못된 값은 400인지 확인한다. 정의되지 않은 필드만 보낸 본문도 필수 필드가 없으므로 400이다.
- 저장된 SIWS 입력과 다른 domain, uri, nonce, chainId, 시간, requestId, 주소, 메시지와 서명을 거절한다.
- 같은 서명 증명의 동시 제출은 한 번만 성공하며 같은 지갑의 서로 다른 최초 챌린지는 계정 하나에 연결되는지 확인한다.
- 다른 브라우저 연결 쿠키, 만료 경계, 비활성 계정을 거절하고 고아 사용자 행이 남지 않는지 확인한다.
- DB 실패는 모든 쓰기를 롤백하고 기존 브라우저 세션을 유지하는지 확인한다.
- 새 로그인은 현재 브라우저 세션만 교체하고 토큰·서명·연결값이 JSON과 로그에 노출되지 않는지 확인한다.
