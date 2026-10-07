# 시즌 캔버스 2단계 프론트 연동 지침

작성일: 2026-10-07

이 문서는 구현된 시즌 참가, 시즌별 실시간 관람·그리기, 종료·복구 흐름을 프론트에서 소비하는 방법을 설명한다. 특정 서버의 배포, DB 마이그레이션, `SEASON_DRAWING_ENABLED=true` 설정을 보장하지 않는다.

HTTP 요청·응답과 오류 명세는 대상 서버의 `/docs`와 `/docs-json`을 기준으로 한다. 소켓 계약은 [서버 이벤트 타입](../../src/modules/canvas/resources/canvas-connections/canvas-events.ts)과 [획 계약](../../src/modules/canvas/resources/canvas-stroke/canvas-stroke.ts)이 원본이다. 메인 캔버스 protocolVersion 1의 기존 wire shape은 유지된다.

## 1. 제공 범위와 기본 흐름

시즌은 무료이며 공개다. 익명 사용자도 취소되지 않은 시즌의 목록·상세와 캔버스를 볼 수 있다. 로그인한 사용자는 진행 중인 시즌에 참가한 뒤 그림을 보낼 수 있다. 개설자는 생성할 때 자동 참가하며 정원 한 자리를 사용한다. 결제, NFT·cNFT, 참가 취소와 자리 반환은 없다.

프론트의 기본 흐름은 다음 순서를 따른다.

1. 목록 또는 상세를 읽고 시즌 ID와 현재 상태를 얻는다.
2. 관람만 필요하면 바로 시즌 소켓에 연결한다.
3. 그리려면 서버 로그인을 확인한 뒤 진행 중 시즌에 참가한다.
4. 참가 성공 후 기존 소켓을 닫고 다시 연결한다.
5. `connection:ready`를 받은 뒤 `canvas:sync`로 그림을 복구한다.
6. ready의 상태가 active이고 `canDraw`가 true일 때 append UI를 연다.
7. `season:state`가 종료를 알리면 새 입력을 닫고 이벤트의 head까지 sync한다.
8. 연결 유실·서버 재시작은 재연결과 sync의 epoch 판정으로 복구한다.

시즌 상태는 서버 DB 시각을 기준으로 `scheduled`, `active`, `ended`, `cancelled` 중 하나다. 시작 시각은 포함하고 종료 시각은 포함하지 않는다. 브라우저 카운트다운은 표시용이며 입장·참가·입력 승인 판단을 대신하지 않는다.

## 2. HTTP 목록·상세, 로그인, 참가

HTTP base에는 환경별 `API_PREFIX`를 포함한다. 브라우저 요청은 HttpOnly 세션 쿠키를 보내도록 `credentials: 'include'`를 사용한다. 조회는 익명으로도 성공할 수 있으므로 로그인 확인에는 `/auth/me`를 사용한다. 쓰기 요청에는 브라우저가 설정한 허용 Origin이 필요하다.

```js
async function apiRequest(apiBase, path, options = {}) {
  const response = await fetch(`${apiBase.replace(/\/+$/, '')}${path}`, {
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
}

const page = await apiRequest(
  API_BASE,
  '/seasons?status=active&page=1&limit=20',
);
const detail = await apiRequest(API_BASE, `/seasons/${seasonId}`);
```

응답의 `isParticipant`, `isCreator`, `canCancel`, `canEnd`는 요청에 포함된 세션 기준이다. 로그인·로그아웃·계정 변경 때 목록·상세 캐시를 비우고 다시 읽는다. 이전 계정 요청의 늦은 응답이 새 계정 상태를 덮지 않도록 계정 세대나 요청 취소를 적용한다. `Cache-Control: no-store`는 프론트 메모리 캐시를 자동으로 지우지 않는다.

진행 중 시즌 참가에는 본문을 보내지 않는다.

```js
const joined = await apiRequest(API_BASE, `/seasons/${seasonId}/join`, {
  method: 'POST',
});
```

신규 참가자는 active 구간에만 등록된다. 정원은 동시 접속 수가 아니라 개설자를 포함한 누적 참가 등록 수다. 범위는 2~100명이며 탈퇴와 자리 반환이 없다. 정원이 가득 차면 참가를 반복하지 말고 최신 상세를 표시한다.

참가는 멱등하게 재전송할 수 있다. 이미 참가한 사용자는 예약·진행·종료 상태와 현재 정원에 관계없이 새 행을 만들지 않고 최신 상세를 받는다. 따라서 타임아웃 뒤 같은 요청을 재전송하고 응답의 `isParticipant`와 `participantCount`로 화면을 교체할 수 있다. 참가 요청은 세션 쿠키를 갱신하지 않는다.

참가 성공만으로 기존 소켓의 ready가 바뀌지는 않는다. 기존 연결을 정리하고 새 handshake를 시작한다. 로그인·로그아웃·계정 변경도 같은 방식으로 재연결한다. 기존 소켓은 연결 당시 쿠키와 사용자 binding을 유지하며, 폐기된 세션으로 append하면 거절된다.

## 3. 시즌 소켓 연결과 ready

HTTP API 접두사를 붙이지 않은 서버 origin에 namespace `/canvas`, path `/realtime`, websocket transport로 연결한다. `auth.canvasKey`는 `season:`과 서버가 반환한 UUID v4를 합친 값이다. append나 sync payload로 다른 캔버스를 선택할 수 없다.

```js
import { io } from 'socket.io-client';

const socket = io(`${BACKEND_ORIGIN}/canvas`, {
  path: '/realtime',
  transports: ['websocket'],
  withCredentials: true,
  auth: { canvasKey: `season:${seasonId}` },
  autoConnect: false,
});

socket.on('connection:ready', handleReady);
socket.on('connection:reset', handleReset);
socket.on('canvas:presence', handlePresence);
socket.on('stroke:preview', handlePreview);
socket.on('season:state', handleSeasonState);
socket.connect();
```

`connect`는 전송 연결만 완료된 상태다. 모든 리스너를 먼저 등록하고 `connection:ready`를 받은 뒤 앱을 준비 상태로 바꾼다. ready의 실제 형태는 다음과 같다.

```ts
type SeasonConnectionReady = {
  protocolVersion: 1;
  canvasKey: `season:${string}`;
  viewer:
    | { status: 'guest'; userId: null }
    | { status: 'authenticated'; userId: string };
  canDraw: boolean;
  presence: { connectionCount: number };
  season: {
    width: number;
    height: number;
    strokeLimitPerUser: number | null;
    startsAt: string;
    endsAt: string;
    cancelledAt: string | null;
    forceEndedAt: string | null;
    status: 'scheduled' | 'active' | 'ended' | 'cancelled';
    isParticipant: boolean;
    isCreator: boolean;
  };
  serverTime: string;
};
```

중요: `connection:ready`에는 `epoch`와 `headSequence`가 없다. 최초 ready 뒤 `canvas:sync`를 호출해 두 값을 얻는다. `season:state`도 상태 변경 시 두 값을 제공한다.

`canDraw`는 연결 당시 인증, 참가, active 상태, 쓰기 flag를 모두 만족했다는 안내다. 남은 획 수나 다음 append의 성공을 보장하지 않는다. 운영 기본값 `SEASON_DRAWING_ENABLED=false`에서는 참가자도 false를 받고 append는 `SEASON_DRAWING_DISABLED`로 거절된다. 대상 환경에서 flag를 true로 설정해야 입력이 열린다.

예약 시즌은 관람·sync만 가능하다. scheduled ready는 `canDraw: false`다. `season:state`에는 개인별 `canDraw`와 `isParticipant`가 없으므로 active 이벤트만으로 그리기 권한을 열지 않는다. 개설자와 기존 참가자는 active 이벤트 뒤 재연결해 새 ready를 받고, 신규 사용자는 참가 HTTP 성공 뒤 재연결한다. 종료 시즌도 읽기 전용으로 연결하고 최종 그림을 복구할 수 있다. 취소 시즌은 개설자만 읽기 전용으로 연결할 수 있다. 비개설자에게는 없는 캔버스처럼 처리된다.

`presence.connectionCount`와 `canvas:presence.connectionCount`는 준비 완료 소켓 수다. 참가자 수나 고유 사용자 수가 아니다. 한 사용자의 여러 탭도 각각 센다.

## 4. 최초 sync, 페이지 복구, epoch 교체

최초 sync는 epoch 없이 `afterSequence: '0'`을 보낸다. 서버는 저장된 좌표와 아직 저장하지 않은 현재 프로세스의 승인 좌표를 캔버스 순서로 합친다.

```ts
type CanvasSyncPage = {
  canvasKey: 'main' | `season:${string}`;
  epoch: string;
  reset: boolean;
  previews: StrokePreview[];
  headSequence: string;
  nextSequence: string;
  hasMore: boolean;
};
```

복구 첫 페이지의 `headSequence`를 `throughSequence`로 고정해 다음 페이지를 요청한다. 페이지가 진행되는 동안 새 preview가 도착하면 같은 epoch의 sequence 버퍼에 넣고, 고정 head 복구가 끝난 뒤 순서대로 합친다. sequence는 bigint 범위의 문자열이므로 JavaScript `number`로 변환하지 않고 비교할 때 `BigInt`를 사용한다.

재연결에는 마지막 epoch와 연속 적용한 sequence를 보낸다. 서버 epoch와 다르면 `reset: true`이며 서버는 sequence 0부터 현재 저장 그림을 반환한다. 이때 이전 그림, cursor, preview 버퍼, ACK 미확정 전송 대기를 모두 비운 뒤 새 페이지를 적용한다. 같은 epoch면 마지막 연속 sequence 이후부터 이어받는다.

서버 runtime이 유휴 회수 후 다시 만들어져도 epoch가 바뀔 수 있다. epoch 변경은 데이터 삭제 뜻이 아니다. 저장된 좌표를 새 epoch와 새 sequence stream으로 다시 동기화하라는 지시다. ready만 비교해서 epoch 변경을 감지할 수 없다.

## 5. append, 획 사용량, 캔버스 크기

ready와 최초 sync가 끝난 뒤 `stroke:append`를 ACK와 함께 보낸다. 좌표는 화면 좌표가 아니라 ready의 `season.width`와 `season.height`를 기준으로 역변환한 원본 좌표다. 서버는 `0 <= x < width`, `0 <= y < height`를 적용한다. 시즌마다 크기가 다를 수 있으므로 메인 10000×10000 값을 재사용하지 않는다.

첫 승인 묶음은 해당 사용자와 해당 캔버스의 획 사용량 1개를 만든다. 메인과 서로 다른 시즌은 사용량을 공유하지 않는다. `strokeLimitPerUser`가 숫자면 시즌별 한도이며 `null`이면 무제한이다. 남은 획 수는 ready나 HTTP 상세에 포함되지 않으므로 프론트 추정값만으로 append를 선승인하지 않는다.

시즌 서버는 모든 좌표 묶음에서 세션, 현재 참가 여부와 DB 시각의 active 상태를 다시 확인한다. 첫 묶음 뒤에도 기존 ready나 이전 ACK만으로 다음 묶음의 권한을 확정하지 않는다.

중단된 획도 사용량을 소비한다. 첫 묶음 뒤 연결이 끊기거나 `isFinal`을 보내지 못해도 횟수는 돌아오지 않는다. 서버가 종료 경계까지 받은 부분 좌표는 `isFinal: false` 상태로 그림에 남는다. 완료 획 수로 바뀌지는 않는다.

각 묶음은 다음 공개 제한을 지킨다.

- `clientStrokeId`는 UUID이고 `chunkIndex`는 0부터 연속 증가한다.
- 한 묶음은 최대 128개 좌표와 JSON 8KiB다.
- 첫 묶음에는 좌표가 필요하다. 마지막 묶음만 빈 points를 사용할 수 있다.
- 한 연결은 append 초당 30회, sync 초당 5회까지다.
- append와 sync는 이벤트별로 한 요청만 진행한다. 이전 ACK 전에 같은 이벤트를 겹쳐 보내면 `RATE_LIMITED`가 될 수 있다.
- sync `limit`은 1~100이며 기본값은 50이다. 응답 페이지는 최대 128KiB다.

ACK는 `{ok:true,data}` 또는 `{ok:false,error:{code,message}}`다. `ok:true`의 `accepted:false`는 같은 묶음의 멱등 재전송 성공이다. 반환된 preview를 sequence 기준으로 한 번만 적용한다. ACK timeout은 서버 미수신을 뜻하지 않으므로 ID, index, brush, points, `isFinal`이 모두 같은 묶음을 재전송한다.

제출자는 자신의 preview를 ACK에서 받고, 다른 연결은 `stroke:preview` 방송으로 받는다. 비-final 방송은 volatile이므로 유실될 수 있다. 모든 연결은 sequence 공백, 재연결, 주기적 보정 때 sync를 사용한다.

## 6. 상태 이벤트와 종료 경계

resident 시즌의 예약 시작, 자연 종료, 조기 종료와 취소가 관찰되면 다음 이벤트가 온다.

```ts
type SeasonStateEvent = {
  canvasKey: `season:${string}`;
  status: 'scheduled' | 'active' | 'ended' | 'cancelled';
  startsAt: string;
  endsAt: string;
  cancelledAt: string | null;
  forceEndedAt: string | null;
  serverTime: string;
  epoch: string;
  headSequence: string;
};
```

`headSequence`는 서버가 승인한 최종 경계이며 DB 저장 완료 표시는 아니다. ended를 받으면 입력 UI를 즉시 닫고, 이벤트 epoch와 head까지 sync한다. 이벤트 뒤 늦게 도착한 preview라도 같은 epoch에서 sequence가 종료 head 이하이면 종료 전에 승인된 데이터일 수 있으므로 버리지 않는다.

입력 승인 시각은 네트워크 도착 시각이 아니다. 서버가 시즌 행을 잠근 뒤 읽은 DB 시각이 종료 전이면 그 묶음은 승인될 수 있고, 승인 transaction이 종료 뒤 커밋돼도 유지된다. gate에서 종료 뒤에 승인 검사를 시작한 묶음은 거절된다. 브라우저가 `endsAt` 전에 emit했다는 사실만으로 성공 처리하지 않는다.

조기 종료는 이미 승인된 head를 저장한 뒤 lifecycle 변경을 커밋한다. 자연 종료도 승인된 부분 획을 저장한다. 저장 실패나 결과 미확정 상태에서는 입력과 일부 작업이 일시적으로 거절될 수 있으며, 서버가 DB 상태를 복구한 뒤 다시 열린 읽기 경계로 전환한다. 프론트는 로컬 상태를 추측하지 말고 ACK, 새 ready, HTTP 상세와 sync를 사용한다.

취소가 확정되면 비개설자는 `connection:reset`의 `canvas_unavailable` 안내 뒤 연결이 종료된다. 개설자는 취소 상태와 최종 그림을 읽기 전용으로 유지한다. 상태 이벤트는 영구 전달 채널이 아니므로 유실되면 재연결 ready, HTTP 상세와 sync로 복구한다.

## 7. 오류, reset, 재시도

소켓 업무 분기는 영어 message가 아니라 `error.code`로 처리한다.

- `SEASON_DRAWING_DISABLED`: 환경 flag가 닫혀 있다. 자동 append 재시도를 멈춘다.
- `AUTH_REQUIRED`, `USER_UNAVAILABLE`: 로그인 상태를 확인한다. 계정 변경 후 새 소켓을 만든다.
- `SEASON_PARTICIPATION_REQUIRED`: 참가 HTTP를 실행하고 성공 후 재연결한다.
- `SEASON_NOT_ACTIVE`: 입력을 닫고 상세 또는 sync로 최신 상태를 읽는다.
- `STROKE_LIMIT_REACHED`: 새 획을 중단하고 한도 도달을 표시한다.
- `INVALID_STROKE`, `INVALID_SYNC`: payload 또는 cursor를 고친다. 같은 잘못된 값을 자동 반복하지 않는다.
- `RATE_LIMITED`: 겹친 요청을 줄이고 최소 1초 뒤 재시도한다.
- `CANVAS_CAPACITY_REACHED`, `REALTIME_UNAVAILABLE`: 현재 묶음과 cursor를 보존하고 지연 재시도한다.
- `CANVAS_NOT_FOUND`: 대상 ID와 공개 범위를 확인하고 자동 재시도를 멈춘다.

`connection:reset`의 `retryable`을 우선한다. `server_shutdown`과 `realtime_unavailable`은 `retryAfterMs` 이상 기다린 뒤 jitter를 더해 재연결한다. `invalid_canvas_key`, `canvas_unavailable`, `connection_policy`는 자동 재연결을 멈춘다. reset은 안내이며 실제 종료는 `disconnect`로 확인한다. reset이 유실될 수 있으므로 이유 없는 disconnect도 제한된 backoff로 복구한다.

상세한 연결 소유권과 재시도 예제는 [실시간 연결 가이드](../api/canvas/realtime-connection.md), append·sync 예제는 [그림 동기화 가이드](../api/canvas/drawing-sync.md)를 따른다.

## 8. 내구성, 종료와 운영 경계

중간 append 성공은 방송 대상으로 승인됐다는 뜻이며 DB 저장 완료를 보장하지 않는다. final append 성공은 해당 획의 좌표와 완료 표식이 저장됐다는 뜻이다. 서버는 정상 종료 때 새 작업을 막고 진행 중 sync·final 작업을 기다린 뒤 main과 각 시즌의 dirty 좌표를 독립적으로 저장한다.

한 캔버스의 종료 저장 실패는 다른 캔버스와 소켓·DB pool 정리를 막지 않는다. registry는 캔버스 ID와 실패 단계를 로그에 남기고 `AggregateError`를 만든다. NestJS 12에서는 provider 종료 오류가 로그에 남아도 `app.close()`가 resolve될 수 있으므로 운영자는 프로세스 종료 성공만으로 무손실 flush를 판단하면 안 된다.

저장 장치 장애, 저장 실패가 남은 정상 종료, 프로세스 강제 종료나 머신 장애에서는 아직 DB에 없는 non-final 좌표가 유실될 수 있다. 서버는 이를 무손실 영구 저장으로 보장하지 않는다. 프론트는 ACK 미확정 묶음을 같은 내용으로 재전송하고, 재접속 때 항상 sync로 서버의 확정 그림을 다시 구성한다.

## 9. 프론트 확인 순서

1. 익명으로 예약·진행·종료 시즌에 연결하고 ready 뒤 sync가 되는지 확인한다.
2. 로그인 후 active 시즌에 참가하고 participantCount가 증가하는지 확인한다.
3. 참가 성공 후 재연결한 ready에서 `isParticipant`와 대상 환경의 `canDraw`를 확인한다.
4. 같은 사용자의 여러 탭이 presence에는 각각 반영되고 참가 인원에는 중복 반영되지 않는지 확인한다.
5. 시즌별 width·height 경계 안 좌표는 승인되고 경계값 좌표는 거절되는지 확인한다.
6. 획 제한이 있는 시즌과 `null`인 시즌, 서로 다른 두 시즌에서 사용량이 독립적인지 확인한다.
7. ACK timeout 뒤 같은 묶음을 재전송해 `accepted:false` 결과가 중복 렌더링되지 않는지 확인한다.
8. 예약 시작과 자연·조기 종료에서 state를 받고 해당 head까지 sync하는지 확인한다.
9. 종료된 부분 획이 재접속과 서버 재시작 뒤에도 `isFinal:false`로 복구되는지 확인한다.
10. epoch 변경 시 기존 그림·cursor·전송 대기를 비우고 저장 그림부터 다시 적용하는지 확인한다.
11. 로그인 계정 변경 후 이전 계정의 HTTP 캐시, 소켓 binding과 그리기 권한이 남지 않는지 확인한다.
12. flag가 false인 환경에서 관람·sync는 유지되고 append만 거절되는지 확인한다.

## 구현 근거와 유지보수

이 문서는 실제 controller, 소켓 이벤트 타입, 연결·접근 경계, append·sync use-case, runtime과 설정을 대조했다. 브라우저 연동이나 배포 환경을 새로 실행한 결과는 아니다. 계약 변경 시 소스와 Swagger를 먼저 갱신하고 이 소비 흐름을 함께 검토한다.

- [시즌 참가 controller](../../src/modules/seasons/features/join-season/join-season.controller.ts)와 [use-case](../../src/modules/seasons/features/join-season/join-season.use-case.ts)
- [시즌 HTTP 응답 모델](../../src/modules/seasons/resources/season/season-http.ts)
- [소켓 이벤트 타입](../../src/modules/canvas/resources/canvas-connections/canvas-events.ts)과 [연결 관리자](../../src/modules/canvas/resources/canvas-connections/canvas-connections.ts)
- [시즌 접근 검사](../../src/modules/canvas/resources/canvas-access/canvas-access.ts)
- [append](../../src/modules/canvas/features/append-stroke/append-stroke.use-case.ts)와 [sync](../../src/modules/canvas/features/sync-canvas/sync-canvas.use-case.ts)
- [획·sync 검증](../../src/modules/canvas/resources/canvas-stroke/canvas-stroke.ts)
- [runtime](../../src/modules/canvas/resources/canvas-drawing/canvas-runtime.ts), [registry](../../src/modules/canvas/resources/canvas-drawing/canvas-runtime-registry.ts), [실시간 설정](../../src/config/realtime.config.ts)
