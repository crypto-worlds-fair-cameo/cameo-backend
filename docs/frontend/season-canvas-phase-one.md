# 시즌 캔버스 1단계 프론트 연동 지침

> 역사 문서: 2026-10-07의 시즌 생성·조회·취소·종료 1단계 범위를 보존한다. 현재 참가·실시간 캔버스 연동에는 [2단계 지침](season-canvas-phase-two.md)을 사용한다. 아래의 “현재”와 “아직 제공하지 않는다”는 표현은 모두 1단계 당시 상태를 뜻한다.

이 문서는 2026-10-07 당시 백엔드 구현을 기준으로, 프론트에서 사용할 수 있던 기능과 소비 방법을 설명한다. 화면 배치나 프론트 프레임워크를 지정하지 않는다. **코드 구현을 확인한 이력 문서이며, 특정 서버의 배포·마이그레이션 완료를 보장하지 않는다.**

정식 HTTP 명세는 대상 서버의 `/docs` → **Seasons**, 기계 판독 명세는 `/docs-json`이다. 요청·응답 타입과 전체 오류 정의는 Swagger를 기준으로 한다. 아래 예제와 설명은 현재 구현의 연동 안내이며 별도 명세 원본이 아니다.

## 1. 현재 제공하는 범위

방 하나가 독립 시즌 하나이며 캔버스 하나를 가진다. 시즌 ID와 캔버스 ID는 같다.

| 작업                | 요청 경로¹                 | 성공 응답의 `data`         |
| ------------------- | -------------------------- | -------------------------- |
| 즉시 개설·예약 개설 | `POST /seasons`            | 생성된 시즌 상세, HTTP 201 |
| 공개 목록           | `GET /seasons`             | 목록 페이지, HTTP 200      |
| 상세                | `GET /seasons/:id`         | 시즌 상세, HTTP 200        |
| 시작 전 취소        | `POST /seasons/:id/cancel` | 취소된 시즌 상세, HTTP 200 |
| 진행 중 조기 종료   | `POST /seasons/:id/end`    | 종료된 시즌 상세, HTTP 200 |

¹ 경로 앞에는 환경별 API 접두사가 붙을 수 있다. `:id`는 서버에서 받은 UUID v4다.

- 개설은 무료이며 모든 시즌은 공개다. 개설자는 자동으로 첫 참가자가 된다.
- 예약 시즌도 개설 즉시 개설자가 등록된다. 초기 `participantCount`는 1이며 정원 한 자리를 사용한다.
- 정원은 현재 접속자 수가 아니라 **누적 참가 등록 인원**이다.
- 개설자별 `scheduled`와 `active` 시즌의 합은 최대 3개다. 취소·종료된 시즌은 이 제한에서 제외된다.
- 수정·삭제·복원 API는 없다. 설정을 바꾸려면 기존 시즌을 취소하거나 종료하고 새로 개설한다. 새 시즌에는 새 ID가 부여된다.

**일반 사용자 참가, 참가자 목록, 시즌 캔버스 실시간 연결·그리기는 아직 제공하지 않는다.** `isParticipant: true` 또는 `status: active`만으로 지금 시즌 그림 연결이 가능하다고 판단하면 안 된다. NFT·cNFT 민팅과 결제도 현재 범위 밖이다.

## 2. 서버 주소와 로그인

`API_BASE`에는 서버 주소와 API 접두사를 함께 넣고 끝의 `/`는 제거한다.

- `API_PREFIX=api`: 예를 들어 `https://api.example.com/api`.
- `API_PREFIX`가 빈 문자열: 예를 들어 `https://api.example.com`.
- 환경 변수를 지정하지 않은 서버의 기본 접두사는 `api`다. 대상 서버의 Swagger에 표시된 경로로 확인한다.
- Swagger 자체의 경로 `/docs`, `/docs-json`에는 이 접두사를 붙이지 않는다.

조회는 로그인 없이 가능하다. 생성·취소·종료는 **서버 로그인 세션**이 필요하다. 지갑 연결만 완료한 상태는 서버 로그인 상태가 아니다. 기존 [지갑 로그인 흐름](../api/auth/login.md)을 사용한다.

브라우저 요청에는 `credentials: 'include'`를 사용한다. 서버는 HttpOnly 세션 쿠키를 읽는다. JavaScript에서 쿠키를 읽거나 `Cookie`, `Origin` 헤더를 직접 조립하지 않는다. Bearer 토큰이나 지갑 주소를 본문에 넣어 인증하는 구조가 아니다.

쓰기 요청은 브라우저의 Origin이 `CORS_ORIGIN_LIST`에 등록되어야 한다. 서버는 credential CORS를 사용한다. 쿠키는 `SameSite=Lax`, `Path=/`이며 production에서는 `Secure`다. 다른 사이트 간 배포에서는 `credentials` 설정만으로 쿠키 전송이 보장되지 않으므로 실제 배포 도메인에서 로그인과 쓰기 요청을 확인한다.

목록·상세는 잘못되거나 만료된 세션을 익명으로 처리할 수 있다. 따라서 조회 HTTP 200은 로그인 확인 수단이 아니다. 로그인 상태는 `/auth/me`로 확인한다. 시즌 조회는 세션 활동을 갱신하지 않는다.

## 3. 응답을 읽는 방법

성공 응답은 시즌 객체 자체가 아니라 공통 envelope다. 아래는 예약 개설 성공의 **형태 예시**다. 고정된 예시 시각을 생성 요청에 그대로 사용하지 않는다.

```json
{
  "statusCode": 201,
  "success": true,
  "data": {
    "id": "c0b73a9f-2649-47af-8bea-736fca6a9d03",
    "creatorId": "b27325db-66a2-4adf-93d1-c5ac41bfe6f1",
    "title": "주말 공동 캔버스",
    "description": null,
    "width": 1000,
    "height": 1000,
    "strokeLimitPerUser": null,
    "capacity": 20,
    "participantCount": 1,
    "startsAt": "2026-10-10T00:00:00.000Z",
    "endsAt": "2026-10-11T00:00:00.000Z",
    "cancelledAt": null,
    "forceEndedAt": null,
    "createdAt": "2026-10-07T00:00:00.000Z",
    "status": "scheduled",
    "isParticipant": true,
    "isCreator": true,
    "canCancel": true,
    "canEnd": false
  }
}
```

목록의 각 item도 위와 같은 상세 형태다. 목록만 받고 상세 표시를 시작할 수 있지만, 시간 경계나 변경 작업 직전에는 오래된 응답일 수 있다.

소비할 때 특히 구분할 값:

- `creatorId`는 사용자 UUID다. 지갑 주소나 닉네임이 아니다.
- 날짜는 JSON 문자열이며 UTC ISO 형식이다. `Date` 객체가 자동으로 들어오는 것은 아니다.
- `description`, `cancelledAt`, `forceEndedAt`는 값이 없을 때 `null`이다.
- `strokeLimitPerUser: null`은 **1인당 획 수 무제한**이다. 정원 무제한을 뜻하지 않는다.
- `isParticipant`, `isCreator`, `canCancel`, `canEnd`는 요청한 세션 기준이다. 같은 ID라도 로그인 사용자에 따라 다르다.
- `canJoin`, `canDraw`, 남은 획 수, 현재 접속자 수, 개설자 닉네임, 썸네일 URL은 현재 응답에 없다.

다음은 프레임워크에 의존하지 않는 요청 예제다. `apiBase`에는 실제 환경 설정값을 전달한다. 네트워크 실패나 JSON이 아닌 응답은 별도 오류로 남겨 생성의 성공 여부를 단정하지 않는다.

```js
function createSeasonClient(apiBase) {
  const base = apiBase.replace(/\/+$/, '');

  return async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      credentials: 'include',
    });
    const body = await response.json();
    if (!response.ok || body.success !== true) {
      throw Object.assign(new Error(body.message ?? 'Request failed.'), {
        statusCode: response.status,
        code: body.code,
        traceId: body.traceId,
      });
    }
    return body.data;
  };
}

// API_BASE는 접두사까지 포함한 프로젝트 환경 설정값이다.
const request = createSeasonClient(API_BASE);
```

## 4. 개설 요청 만들기

### 기본값과 입력 변환

필수 입력은 제목, 정원, 종료 시각이다. 생략 가능한 값의 기본 동작은 다음과 같다.

- 가로·세로를 생략하면 각각 1000이다. 지정할 때는 각각 500~10000의 정수다.
- 획 제한을 생략하면 1이다. 제한형은 1~10 정수, 무제한형은 명시적인 `null`이다.
- 정원은 2~100 정수다. 개설자도 포함한다.
- 제목은 앞뒤 공백 제거 후 1~50자, 설명은 최대 100자다. 서버는 Unicode code point 수를 센다.
- 설명 생략 또는 빈 문자열은 응답에서 `null`이 된다. 요청의 `description: null`은 허용하지 않는다.

HTML 입력값은 문자열일 수 있다. JSON에는 `capacity: 20`처럼 숫자를 보내며 `"20"`을 보내지 않는다. 빈 입력을 `Number('')`로 변환하면 0이 되므로 빈 값 여부를 먼저 처리한다. 글자 수를 맞출 때는 `Array.from(value.trim()).length`가 서버 기준과 대응한다. 이모지 묶음 하나가 여러 code point일 수 있다.

`null`과 생략을 구분한다. 예를 들어 `strokeLimitPerUser ?? 1`은 무제한을 1획으로 바꿔 버린다. 기본값이 필요하면 `value === undefined ? 1 : value`처럼 구분한다. 다른 선택 입력에 무조건 `null`을 넣지 않는다.

정의되지 않은 body 필드는 제거된다. `fee`, `visibility`, `creatorId` 등을 추가해도 그 설정을 저장하거나 변경하지 않는다. 오타 필드가 성공 응답을 받았다는 이유로 적용됐다고 판단하지 않는다.

### 즉시 개설

```js
const season = await request('/seasons', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '주말 공동 캔버스',
    description: '함께 완성해요',
    capacity: 20,
    strokeLimitPerUser: 3,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }),
});
```

즉시 개설은 `startsAt`을 **생략**한다. 서버가 처리 시점의 DB 시각으로 결정한다. 클라이언트의 현재 시각을 넣으면 도착 시 이미 과거여서 실패할 수 있다.

종료는 시작부터 최소 1시간, 최대 30일이다. 즉시 개설에서 클라이언트 현재 시각에 정확히 1시간을 더하면 통신 지연 때문에 서버 기준 최소 기간을 충족하지 못할 수 있다. 최소 경계에 여유를 두고, 최종 판단은 서버 응답을 따른다. 30일은 달력의 한 달이 아니라 30 × 24시간이다.

### 예약 개설

```js
const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
const reserved = await request('/seasons', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '내일 두 시간 캔버스',
    capacity: 100,
    strokeLimitPerUser: null,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  }),
});
```

예약 시작은 서버 현재 시각부터 최대 30일 이내다. 종료 시각은 예약 시작에서 1시간~30일 뒤다. 종료 시각 자체를 서버 현재부터 30일 이내로 제한하는 규칙은 아니다.

시각은 초까지 포함하고 `Z` 또는 `+09:00` 같은 시각대가 필요하다. 소수 초는 생략하거나 1~3자리다. `datetime-local`의 시각대 없는 문자열을 그대로 보내지 않는다. 사용자가 선택한 시각대를 해석한 뒤 절대 시각으로 변환한다. JavaScript `toISOString()`은 지원하는 형식이다.

### 성공 후와 재전송

반환된 `id`와 서버가 정규화한 값을 사용한다. 제목 공백이나 서버가 결정한 시작 시각을 제출 전 입력값으로 덮어쓰지 않는다. 생성 성공 후 목록도 다시 조회하면 상태 필터·정렬과 맞출 수 있다.

생성에는 idempotency key가 없다. 같은 요청을 다시 보내면 다른 시즌이 생긴다. 네트워크 단절·타임아웃·응답 해석 실패 때 자동 재시도하지 않는다. 목록에서 결과를 확인하되 제목만으로 동일 요청의 성공을 확정할 수는 없다. 현재 생성 요청 추적 API나 내 시즌 전용 필터도 없다.

## 5. 목록과 상세 소비

```js
const query = new URLSearchParams({ page: '1', limit: '20' });
query.set('status', 'active'); // 전체 목록이면 status 자체를 생략한다.
const page = await request(`/seasons?${query}`);
const detail = await request(`/seasons/${season.id}`);

// page: { items: [...], page: 1, limit: 20, hasNext: boolean }
```

기본 페이지는 1, 기본 개수는 20이며 최대 100개다. 페이지 값은 양의 정수 문자열로 보낸다. `01`, 소수, 빈 문자열, 같은 키의 반복 전달은 피한다. 상태 필터는 `scheduled`, `active`, `ended`만 지원한다. `all`이나 `cancelled`를 보내지 않는다.

목록은 생성 시각 내림차순, 같은 시각이면 ID 내림차순이다. 총 개수나 총 페이지 수는 없으며 `hasNext`로 다음 페이지를 판단한다. 검색·인기순·내 방 필터는 없다. 임의 query가 무시될 수 있으므로 지원 여부를 성공 상태만으로 판단하지 않는다.

Offset pagination이므로 조회 사이에 시즌이 추가되거나 상태가 바뀌면 중복·누락이 생길 수 있다. 이어 붙일 때는 ID로 중복을 제거하고 최신 목록이 필요하면 첫 페이지부터 다시 조회한다.

취소된 시즌은 개설자 자신의 목록에서도 제외된다. 상세는 개설자에게만 보인다. 다른 사용자와 익명에게는 존재하지 않는 시즌과 같은 404가 반환된다. 취소 직후 상세를 유지해야 한다면 취소 응답의 ID와 데이터를 사용한다.

응답에는 사용자별 값이 포함된다. 로그인·로그아웃·계정 변경 후 목록과 상세 캐시를 갱신하고, 이전 사용자의 응답이 늦게 도착해 현재 상태를 덮지 않도록 처리한다. 서버의 `Cache-Control: no-store`는 프론트 메모리 캐시를 자동으로 지우지 않는다.

## 6. 상태와 개설자 동작

서버 DB 시각이 기준이며 시작 시각은 포함하고 종료 시각은 포함하지 않는다.

| 서버 상태   | 의미                           | 개설자의 신규 변경 동작 |
| ----------- | ------------------------------ | ----------------------- |
| `scheduled` | 시작 전                        | 취소 가능               |
| `active`    | 시작 시각 이상, 종료 시각 미만 | 조기 종료 가능          |
| `ended`     | 예정 종료 도달 또는 조기 종료  | 없음                    |
| `cancelled` | 시작 전에 취소됨               | 없음                    |

응답의 `canCancel`, `canEnd`를 동작 가능 여부의 기준으로 사용한다. 이는 조회 당시의 값이며 요청 성공을 보장하지 않는다. 로컬 카운트다운이 끝나면 최신 상세를 조회한다. 현재 시즌 상태 변경을 푸시하는 이벤트는 없다.

취소와 조기 종료는 별개다. 진행 중 시즌을 취소하려고 요청하면 실패하며 자동으로 종료로 전환되지 않는다. 취소가 가능한 순간에 눌렀더라도 서버 처리 전에 시작 시각을 넘으면 실패할 수 있다.

```js
// 사용자가 선택한 동작 하나를 실행한다. 상태 변경 시 다른 동작으로 자동 대체하지 않는다.
const cancelled = await request(`/seasons/${reserved.id}/cancel`, {
  method: 'POST',
});

// 별개의 진행 중 시즌을 조기 종료하는 예제다.
const ended = await request(`/seasons/${season.id}/end`, {
  method: 'POST',
});
```

두 요청 모두 본문이 필요 없다. 성공 응답으로 상세를 교체하고 목록을 다시 조회한다. 취소된 항목은 목록에서 빠지며 조기 종료된 항목은 `ended` 필터에 속한다.

같은 개설자가 이미 성공한 취소를 다시 취소하거나 이미 강제 종료한 시즌을 다시 종료하면 기존 결과를 반환한다. 최초 처리 시각도 유지한다. 다만 자연 종료 후 `/end`를 호출하는 것은 이 재전송 성공에 해당하지 않는다. 취소 후 종료, 종료 후 취소도 실패한다.

조기 종료해도 `endsAt`은 원래 예정 시각을 유지한다. 실제 조기 종료 시각은 `forceEndedAt`이다. 종료 시각을 표시하려면 종료 상태에서 `forceEndedAt ?? endsAt`을 사용한다. 취소는 `cancelledAt`으로 별도 구분한다.

## 7. 실패 후 이어갈 흐름

오류 응답은 `{ statusCode, success: false, code, message, traceId? }`다. 업무 분기는 영어 `message` 문구보다 `code`로 처리한다. 전체 오류 명세는 Swagger에서 확인한다.

- 입력 검증 실패는 제출값을 유지한 채 수정할 수 있게 처리한다. 설정 규칙 실패의 `SEASON_INPUT_INVALID` 외에 DTO·UUID 검증의 `BadRequestException`도 올 수 있다. `message`는 문자열이며 필드별 오류 객체가 아니다.
- `AUTH_SESSION_INVALID`이면 서버 로그인 상태를 다시 확인한다. `AUTH_ORIGIN_NOT_ALLOWED`는 로그인 재시도로 해결되지 않는 출처 설정 문제다. `AUTH_USER_UNAVAILABLE`은 계정 사용 제한이므로 무한 재로그인을 시도하지 않는다.
- `SEASON_ACTIVE_LIMIT_REACHED`이면 새 생성 요청을 반복하지 않는다. 기존 예약·진행 시즌을 확인한다.
- `SEASON_OWNER_REQUIRED`이면 최신 로그인 사용자와 상세를 확인한다. 다른 계정의 캐시가 남았는지도 확인한다.
- `SEASON_STATE_CONFLICT`이면 상세와 목록을 다시 읽는다. 시작·종료 경계를 넘었거나 이미 다른 동작이 수행됐을 수 있다. 자동으로 취소를 종료로 바꾸지 않는다.
- `SEASON_NOT_FOUND`이면 삭제됐다고 단정하지 않는다. 취소된 방의 공개 접근 제한일 수도 있다.
- 네트워크 실패, 프록시의 비 JSON 응답, 5xx는 정상 업무 오류와 구분한다. 생성 결과가 불명확하면 앞 절의 재전송 주의를 따른다. 서버 오류를 전달할 때 응답에 있는 `traceId`를 함께 남길 수 있다.

## 8. 제공된 디자인과 현재 연동 경계

| 디자인의 기능                          | 지금 사용할 수 있는 백엔드                 |
| -------------------------------------- | ------------------------------------------ |
| 방 개설 양식·개설 완료                 | 생성 API와 생성 결과 상세                  |
| 시즌 목록·정보 모달                    | 목록·상세 API, 사용자별 개설자·참가 플래그 |
| 예약·진행·종료 상태                    | 서버 `status`와 시각 값                    |
| 개설자의 취소·조기 종료                | 각 POST API                                |
| 일반 사용자의 참가·정원 초과 안내      | 참가 API 미구현. 숫자 표시만 가능          |
| 입장료·결제 중·결제 완료               | 현재 무료 정책이며 결제 API 없음           |
| 시즌 캔버스 입장·그리기·종료 그림 보기 | 시즌용 실시간 연결과 그림 조회 미구현      |
| 썸네일·작품 미리보기                   | 현재 시즌 응답에 이미지 데이터·URL 없음    |
| NFT 발행                               | 별도 후속 범위                             |

캔버스는 흰 바탕으로 시작하는 설정이지만 1단계 생성 성공이 이미지 파일이나 그림 데이터를 반환하는 것은 아니다. 기존 `/canvas` 소켓은 메인 캔버스 흐름이다. 시즌 ID를 넘겨 시즌 방으로 연결된다고 가정하지 않는다. 후속 계획에 있는 handshake나 참가 경로는 아직 사용 가능한 계약이 아니다.

현재 `/end`가 제공하는 것은 시즌 생명주기의 종료 처리다. 시즌 소켓의 획 입력 차단·진행 중 획 보존까지 구현 완료된 것으로 해석하지 않는다. 해당 동작은 시즌 그리기 연결 단계에서 함께 제공해야 한다.

## 9. 실제 연동 확인 항목

테스트 코드 작성 없이 브라우저와 대상 서버에서 다음 흐름을 확인할 수 있다.

1. 대상 서버의 마이그레이션과 Seasons API 배포 여부, API 접두사, 허용 Origin을 확인한다.
2. 익명으로 목록·공개 상세를 조회한다. 로그인 후 같은 상세의 사용자별 플래그를 다시 확인한다.
3. 즉시 개설과 예약 개설을 각각 수행하고 반환된 시작 시각·상태·참가 인원 1을 확인한다.
4. 획 제한 `null`과 생략을 구분해 무제한과 기본 1획으로 반환되는지 확인한다.
5. 예약 취소 후 공개 목록에서 제외되는지, 개설자는 상세를 조회할 수 있는지 확인한다.
6. 진행 중 조기 종료 후 `status`, `forceEndedAt`, 유지된 `endsAt`을 확인한다.
7. 로그인 계정 전환 후 이전 계정의 권한 플래그가 남지 않는지 확인한다.
8. 입력 오류·열린 시즌 3개 제한·상태 충돌에서 응답 코드를 처리하고 불필요한 재생성을 하지 않는지 확인한다.

## 구현 근거와 유지보수

이 문서 작성에서는 아래 소스를 대조했다. 브라우저 연동이나 대상 서버 배포를 새로 실행해 검증한 문서는 아니다. 계약 변경 시 Swagger 원본을 먼저 확인하고 이 문서의 소비 예제를 함께 갱신한다.

- [생성 controller와 입력 문서](../../src/modules/seasons/features/create-season/create-season.controller.ts)
- [생성 처리와 개설자 자동 참가](../../src/modules/seasons/features/create-season/create-season.use-case.ts)
- [입력 정규화·시간 경계·사용자별 플래그](../../src/modules/seasons/resources/season/season.ts)
- [HTTP 응답 모델과 날짜 직렬화](../../src/modules/seasons/resources/season/season-http.ts)
- [목록 query 처리](../../src/modules/seasons/features/list-seasons/list-seasons.controller.ts), [목록 조회](../../src/modules/seasons/features/list-seasons/list-seasons.use-case.ts)
- [상세 공개 범위](../../src/modules/seasons/features/get-season/get-season.use-case.ts)
- [취소 처리](../../src/modules/seasons/features/cancel-season/cancel-season.use-case.ts), [조기 종료 처리](../../src/modules/seasons/features/end-season/end-season.use-case.ts)
- [전역 입력 검증](../../src/http/validation-options.ts), [성공 envelope](../../src/http/response.interceptor.ts), [오류 envelope](../../src/http/errors/http-exception.filter.ts)
- [인증 쿠키](../../src/modules/auth/resources/auth-cookie/auth-http.ts), [API 접두사](../../src/config/app.config.ts)
- [시즌 DB 마이그레이션](../../db/migrations/2026-10-06-01-seasons.sql)
- [짧은 시즌 사용 가이드](../api/seasons/lifecycle.md), [전체 API 안내](../api/app.md)
