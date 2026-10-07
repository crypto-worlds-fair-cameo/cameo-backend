# 캔버스 실시간 연결 프론트 가이드

작성일: 2026-10-02

상태: **메인 캔버스 그림과 시즌별 관람·복구·조건부 그림 입력 구현.** 시즌 입력은 운영 기본값 `SEASON_DRAWING_ENABLED=false`로 닫혀 있다.

연결 이벤트의 계약은 [서버 이벤트 타입](../../../src/modules/canvas/resources/canvas-connections/canvas-events.ts)을 기준으로 한다. HTTP 로그인은 [기존 로그인 가이드](../auth/login.md)를 따른다.

## 1. 지금 사용할 수 있는 기능

메인 캔버스 페이지에서 로그인 여부와 관계없이 연결한다. 서버가 메인 room 참가를 처리하므로 프론트에서 참가 이벤트를 보낼 필요가 없다.

- `connection:ready`를 받으면 관람 연결이 준비된 것이다.
- `canvas:presence`를 받으면 현재 연결 수를 교체한다.
- `connection:reset`을 받으면 준비 상태를 해제하고 종료 후의 재시도 정책을 확인한다.
- 실제 종료 여부는 Socket.IO의 `disconnect`로 확인한다. reset 알림이 유실될 수도 있다.

ready의 viewer는 접속 시 세션 쿠키를 검증한 결과다. 유효한 세션은 `authenticated`, 쿠키가 없거나 유효하지 않으면 `guest`다. `canDraw`는 접속 시 인증 여부를 안내하며 남은 획 수를 보장하지 않는다. 획의 첫 좌표에서 세션과 메인 캔버스의 평생 1획 제한을 검사한다. 마지막 좌표 전송에서 세션을 다시 검증하고, 중간 전송에서는 해당 획의 인증 상태를 사용한다. 중간에 연결이 끊겨도 사용한 획은 차감된 상태로 유지한다. 소켓의 guest 상태만으로 HTTP 로그인 쿠키를 지우지 않는다.

연결 수는 사용자 수가 아니다. 한 사람이 탭 두 개를 열면 2개로 센다. UI에는 ‘연결 수’로 표시한다.

## 2. 연결 확인 예제

프론트에 `socket.io-client@4.8.3`을 설치한다. 아래 함수는 페이지 한 곳에서 소유하고 화면을 떠날 때 `dispose()`를 호출한다. `onState`, `onPresence`에는 프론트의 상태 갱신 함수를 전달한다.

아래 예제는 수동 재시도 버튼 없이 연결을 복구한다. 네트워크 끊김과 재시도 가능한 서버 종료를 같은 타이머로 처리한다. 중복 재접속을 막기 위해 Socket.IO 자체 자동 재연결은 끄고, 프론트 함수가 재시도를 관리한다. 재시도 불가 안내나 지원하지 않는 계약을 받으면 연결을 정리하고 실패 상태를 표시한다.

```js
import { io } from 'socket.io-client';

/** 페이지가 연결 하나를 소유하고, 복구 가능한 종료만 자동 재시도한다. */
export function openMainCanvasConnection(backendOrigin, onState, onPresence) {
  const socket = io(`${backendOrigin}/canvas`, {
    path: '/realtime',
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 10000,
  });
  let ready = false;
  let stopped = false;
  let resetNotice = null;
  let retryTimer;
  let readyTimer;
  let retryAttempt = 0;
  let unexplainedDisconnects = 0;

  function clearTimers() {
    clearTimeout(retryTimer);
    clearTimeout(readyTimer);
    retryTimer = undefined;
    readyTimer = undefined;
  }

  // 종료 중 발생하는 disconnect가 새 재시도를 만들지 않도록 먼저 중단한다.
  function fail(reason, details) {
    if (stopped) return;
    stopped = true;
    ready = false;
    clearTimers();
    socket.disconnect();
    onState({ status: 'failed', reason, details });
  }

  /** 서버의 최소 대기 시간을 지키고, 접속이 몰리지 않도록 지연에 무작위 시간을 더한다. */
  function scheduleReconnect(reason, notice) {
    if (stopped || retryTimer !== undefined) return;
    ready = false;
    clearTimeout(readyTimer);
    readyTimer = undefined;
    const base = 1000 * 2 ** Math.min(retryAttempt++, 3);
    const minimum = Number.isFinite(notice?.retryAfterMs)
      ? Math.max(0, notice.retryAfterMs)
      : 0;
    const retryAfterMs = Math.max(
      minimum,
      base + Math.floor(Math.random() * base * 0.25),
    );
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (stopped) return;
      resetNotice = null;
      socket.connect();
    }, retryAfterMs);
    onState({ status: 'reconnecting', reason, retryAfterMs });
  }

  socket.on('connect', () => {
    if (stopped) return;
    clearTimers();
    ready = false;
    resetNotice = null;
    onState({ status: 'initializing' });
    readyTimer = setTimeout(() => {
      socket.disconnect();
      scheduleReconnect('ready_timeout');
    }, 5000);
  });
  socket.on('connection:ready', (payload) => {
    if (stopped) return;
    if (payload?.protocolVersion !== 1 || payload?.canvasKey !== 'main') {
      return fail('unsupported_protocol');
    }
    if (
      !Number.isSafeInteger(payload.presence?.connectionCount) ||
      payload.presence.connectionCount < 1
    ) {
      return fail('invalid_ready');
    }
    clearTimers();
    ready = true;
    retryAttempt = 0;
    unexplainedDisconnects = 0;
    onPresence(payload.presence.connectionCount);
    onState({
      status: 'ready',
      viewer: payload.viewer,
      canDraw: payload.canDraw,
    });
  });
  socket.on('canvas:presence', (payload) => {
    if (
      ready &&
      payload?.canvasKey === 'main' &&
      Number.isSafeInteger(payload.connectionCount) &&
      payload.connectionCount >= 1
    ) {
      onPresence(payload.connectionCount);
    }
  });
  socket.on('connection:reset', (notice) => {
    if (stopped) return;
    ready = false;
    resetNotice = notice;
    if (notice?.retryable !== true) {
      return fail(notice?.reason ?? 'invalid_reset', notice);
    }
    // 서버가 종료를 알렸으므로 현재 연결을 닫고 안내된 시간 이후 다시 접속한다.
    socket.disconnect();
    scheduleReconnect(notice.reason, notice);
  });
  socket.on('disconnect', (reason) => {
    const wasReady = ready;
    ready = false;
    clearTimeout(readyTimer);
    readyTimer = undefined;
    // 이 함수가 직접 닫은 연결은 호출한 곳에서 재시도 또는 종료를 결정한다.
    if (stopped || reason === 'io client disconnect') return;
    if (
      reason === 'io server disconnect' &&
      !resetNotice &&
      !wasReady &&
      ++unexplainedDisconnects >= 3
    ) {
      return fail('repeated_server_disconnect');
    }
    scheduleReconnect(reason, resetNotice);
  });
  socket.on('connect_error', (error) => {
    if (stopped) return;
    ready = false;
    if (
      error.data?.retryable === false ||
      (!socket.active && error.data?.retryable !== true)
    ) {
      return fail(error.message, error.data);
    }
    scheduleReconnect(error.message, error.data);
  });

  // 모든 수신 리스너를 먼저 등록한 뒤 접속한다.
  onState({ status: 'connecting' });
  socket.connect();

  return {
    socket,
    dispose() {
      stopped = true;
      ready = false;
      clearTimers();
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
```

로컬 `backendOrigin`은 `http://localhost:5000`이다. HTTP API base가 `/api`로 끝나더라도 소켓 주소에 `/api`를 붙이지 않는다. 브라우저 기본 `new WebSocket()` 대신 Socket.IO 클라이언트를 사용한다.

시즌 연결은 같은 설정에 `auth.canvasKey`만 추가한다. 서버가 해당 시즌 room과 크기를 결정하며, payload로 다른 캔버스를 선택할 수 없다. `connection:ready`의 시즌 상태와 크기를 표시하고, ready 뒤 `canvas:sync`로 해당 캔버스를 복구한다. 시즌 ready에는 `epoch`와 `headSequence`가 없다. 두 값은 sync 응답과 `season:state`에서만 얻는다.

```js
const socket = io(`${backendOrigin}/canvas`, {
  path: '/realtime',
  transports: ['websocket'],
  withCredentials: true,
  auth: { canvasKey: `season:${seasonId}` },
});
```

예약 시즌은 익명도 연결하고 sync할 수 있지만 `canDraw`는 false다. 종료된 시즌도 읽기 전용으로 연결·복구할 수 있다. 진행 중인 참가자는 쓰기 flag가 켜진 환경에서만 `canDraw: true`를 받는다. `canDraw`는 연결 시점의 안내이므로 append ACK를 대신하지 않는다. 참가 직후, 로그인·로그아웃·계정 변경 후에는 기존 소켓을 정리하고 새 handshake로 연결한다.

시즌의 전체 HTTP·소켓 상태 흐름과 이벤트 형태는 [2단계 프론트 연동 지침](../../frontend/season-canvas-phase-two.md)을 따른다.

백엔드의 `CORS_ORIGIN_LIST`에 실제 프론트 Origin을 넣는다. 기본 허용값은 `http://localhost:5173`이며, `http://127.0.0.1:5173`은 다른 Origin이다. 브라우저가 Origin을 직접 보낸다. Node 테스트 도구에서는 Origin 헤더를 명시해야 한다.

## 3. 연결 상태와 재시도

`connect`는 전송 연결 성공이고, 앱의 준비 상태는 `connection:ready`를 받은 뒤부터다. ready 전에 온 presence는 버리고 ready의 최신 집계값으로 시작한다. 연결 상태와 그림 동기화 상태를 구분한다.

| 상황                                     | 처리                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| 네트워크 끊김·일시적인 연결 오류         | 프론트의 재시도 타이머로 자동 복구하며 ‘연결 복구 중’ 표시 |
| 서버가 재시도 가능한 종료를 안내         | 현재 연결을 닫고 서버의 최소 대기 시간 이후 자동 재연결    |
| 재시도 불가 종료 또는 영구적인 연결 거절 | 재시도를 멈추고 실패 이유 표시                             |
| 안내 없는 서버 강제 종료                 | 지연 재연결. ready를 받지 못하고 3회 연속 반복되면 중단    |
| 화면 이탈                                | 리스너·타이머와 연결을 정리하고 재연결하지 않음            |

서버 정상 종료에서도 `disconnect` 이유가 `transport close`로 올 수 있다. 이유 문자열 하나만으로 정상 종료 여부를 확정하지 않는다. `connection:reset`은 안내이며 종료 감지 자체를 대신하지 않는다. [Socket.IO 연결 이벤트](https://socket.io/docs/v4/client-socket-instance/)

예제의 복구 정책은 다음과 같다. 수동 재시도 버튼은 제공하지 않는다.

- 서버 reset의 `retryable: false`이면 자동 재시도를 멈춘다.
- 자동 재시도는 약 1초부터 최대 10초까지 늘리고 jitter를 적용한다. 서버가 더 긴 `retryAfterMs`를 주면 그 최소 지연을 지킨다. ready를 받은 뒤 대기 시간과 연속 종료 횟수를 초기화한다.
- ready 없이 이유를 알 수 없는 서버 강제 종료가 3회 연속 발생하면 자동 재연결을 멈추고 실패 이유를 표시한다.
- `connect` 이후 5초 안에 ready가 없으면 해당 연결을 정리하고 지연 재시도한다. ready 수신·종료·새 접속·화면 이탈 때 기존 타이머를 취소한다.
- 계약 버전과 payload의 기본 타입을 확인한다. 지원하지 않는 계약은 자동 재시도로 해결하지 않는다.
- 연결이 끊기면 확정된 그림을 유지하며 ‘재연결 중’을 표시한다. 새 ready를 받으면 [그림 동기화 가이드](drawing-sync.md)에 따라 누락된 획을 복구한다.
- 이 예제는 `reconnection: false`이므로 `socket.active`가 true여도 Socket.IO가 자동 재연결하지 않는다. 화면 상태는 `onState`를 기준으로 하고, 별도 자동 재시도 루프를 추가하지 않는다.

## 4. React와 연결 소유권

메인 페이지 또는 상위 Provider 한 곳이 연결을 소유한다. 그림 컴포넌트와 연결 수 배지는 같은 상태를 구독한다.

- render 안에서 `io()`를 호출하지 않는다.
- 수신 리스너를 `connect` 콜백 안에서 반복 등록하지 않는다.
- Effect cleanup에서 `dispose()`를 호출한다. StrictMode의 setup·cleanup·setup 뒤에는 마지막 연결만 남아야 한다.
- 비동기 UI 처리는 시작한 연결이 현재 연결인지 확인한 뒤 적용한다. 자동 재접속도 새 연결로 취급한다.
- 연결 수는 서버가 보내준 값으로 교체한다. 프론트에서 1씩 더하거나 빼지 않는다.

## 5. 로그인과 그림 동기화

그림은 `stroke:append`, `stroke:preview`, `canvas:sync`로 전송·방송·복구한다. 완료는 마지막 append의 `isFinal`로 표시한다. [그림 동기화 가이드](drawing-sync.md)를 따른다. room 참가는 서버가 처리하며 별도의 시작·취소 이벤트는 없다. 연습하기는 프론트에서 처리한다.

로그인·로그아웃 후 소켓을 다시 연결해 새 handshake 쿠키를 사용한다. 지갑 주소나 `isLoggedIn` 값으로 인증하지 않는다. 기존 연결의 폐기된 세션은 그리기 요청에서 거절된다. 소켓 트래픽은 HTTP 세션의 활동 만료를 연장하지 않는다.

끊긴 동안 preview를 Socket.IO 기본 버퍼에 쌓지 않는다. ACK를 확인하지 못한 좌표 묶음은 같은 획 ID·chunkIndex·데이터로 재전송한다. 재접속과 서버 재시작 뒤에는 그림 동기화를 먼저 실행한 뒤 남은 재전송을 처리한다. 서버 재시작으로 epoch가 바뀌면 이전 그림과 재전송 대기를 비우고, sync가 돌려준 저장된 그림부터 반영한다.

## 6. 프론트 연결 확인 순서

1. 두 브라우저에서 연결하고 둘 다 ready를 받는지 확인한다.
2. 한 브라우저를 닫으면 다른 브라우저의 연결 수가 바뀌는지 확인한다.
3. 네트워크를 끊었다 복구하고 새 ready와 현재 연결 수를 받는지 확인한다.
4. 페이지 이탈·재진입 때 이벤트 리스너와 소켓이 중복되지 않는지 확인한다.
5. 서버 종료·재시작 후 버튼 없이 자동 복구되고 새 ready를 받는지 확인한다.
6. 소켓의 guest 상태가 기존 HTTP 로그인 상태를 덮어쓰지 않는지 확인한다.
7. 재시도 불가 안내를 받으면 자동 복구가 멈추고 실패 이유가 표시되는지 확인한다.
