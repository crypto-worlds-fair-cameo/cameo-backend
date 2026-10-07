# 시즌 생명주기 사용 가이드

현재 전체 연동 흐름은 [시즌 캔버스 2단계 프론트 연동 지침](../../frontend/season-canvas-phase-two.md)을 참고한다. [1단계 지침](../../frontend/season-canvas-phase-one.md)은 2026-10-07 당시 생성·조회·취소·종료 범위를 보존한 이력 문서다.

요청·응답 필드와 오류 코드는 [Swagger UI](http://localhost:5000/docs)의 Seasons 항목에서 확인한다. `API_BASE`는 배포 주소와 `API_PREFIX`를 포함한 값으로 설정한다. 로컬에서 접두사를 사용하지 않으면 `http://localhost:5000`이다.

시즌은 무료이며 모두 공개된다. 목록과 상세는 로그인 없이 조회할 수 있으며, 세션 쿠키가 있으면 응답에 현재 사용자의 참가·개설자 상태와 가능한 동작이 반영된다. 생성한 사용자는 자동으로 첫 참가자가 된다.

```js
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000';

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message), body);
  return body.data;
}
```

## 생성과 예약

로그인 뒤 브라우저에서 시즌을 생성한다. 브라우저가 보내는 Origin이 서버 허용 목록에 등록되어 있어야 한다. `startsAt`을 생략하면 서버의 현재 시각에 시작하고, 지정하면 예약 시즌이 된다.

```js
const season = await request(`${API_BASE}/seasons`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '주말 공동 캔버스',
    description: '함께 완성해요',
    capacity: 20,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }),
});
```

생성 요청에는 idempotency key가 없다. 응답을 받지 못한 생성 요청을 그대로 재전송하면 새 시즌이 만들어질 수 있으므로, 먼저 목록에서 생성 결과를 확인한다.

## 목록과 상세

목록은 최신 생성순이며 취소된 시즌을 포함하지 않는다. 상태별 화면에서는 query로 필터하고, 다음 페이지가 있으면 page를 증가시킨다.

```js
const firstPage = await request(
  `${API_BASE}/seasons?status=active&page=1&limit=20`,
);

const selected = await request(`${API_BASE}/seasons/${season.id}`);
```

목록은 offset pagination을 사용한다. 페이지를 넘기는 동안 새 시즌이 생성되거나 필터 대상의 상태가 바뀌면 항목이 중복되거나 빠질 수 있다. 화면에서는 ID로 중복을 제거하고, 최신성이 중요할 때는 첫 페이지부터 다시 조회한다.

취소된 시즌은 목록에서 사라지며 개설자만 상세를 다시 조회할 수 있다.

## 참가와 재전송

로그인한 사용자는 진행 중인 시즌에 참가한다. 참가 요청에는 본문을 보내지 않는다.

```js
const joined = await request(`${API_BASE}/seasons/${selected.id}/join`, {
  method: 'POST',
});
```

응답을 받지 못하면 같은 참가 요청을 다시 보낼 수 있다. 이미 참가한 사용자의 재요청은 참가 기록을 추가하지 않고 최신 시즌 상세를 반환한다. 따라서 재전송 응답의 `isParticipant`와 `participantCount`로 화면 상태를 갱신한다.

예약 시즌은 시작 후 참가하고, 종료된 시즌에는 새로 참가하지 않는다. 이미 참가한 사용자는 시즌이 종료된 뒤에도 같은 요청으로 최신 상세를 받을 수 있다.

## 취소와 조기 종료

개설자는 예약 시즌을 시작 전에 취소하고, 진행 중인 시즌을 예정 시각보다 일찍 종료할 수 있다. 두 요청은 본문을 보내지 않는다.

```js
const latest = await request(`${API_BASE}/seasons/${season.id}`);
if (latest.canCancel) {
  await request(`${API_BASE}/seasons/${season.id}/cancel`, { method: 'POST' });
} else if (latest.canEnd) {
  await request(`${API_BASE}/seasons/${season.id}/end`, { method: 'POST' });
}
```

같은 취소 또는 종료 요청을 재전송하면 최초 처리 시각을 유지한 결과가 반환된다. 종료해도 원래 예정 종료 시각은 바뀌지 않는다.

조기 종료는 서버의 종료 처리에 들어가기 전에 수락한 좌표를 먼저 저장하고 이후 입력을 닫는다. 종료 HTTP 요청이 진행되는 동안 gate에서 먼저 수락된 좌표도 이 범위에 포함된다. 버튼을 누른 시각이나 네트워크 도착 시각이 경계는 아니다. 일시적인 저장·DB 장애 응답에는 같은 종료 요청을 다시 보낼 수 있으며, 서버는 확정된 최초 종료 결과를 유지한다.

## 시즌 캔버스 관람

시즌 ID를 `season:` key로 만들어 기존 `/canvas` namespace에 연결한다. HTTP API 접두사는 소켓 주소에 붙이지 않는다. 관람은 로그인 없이 가능하고, 참가·로그인 상태는 `connection:ready` 안내에 반영된다. 참가 직후에는 소켓을 다시 연결해 ready를 갱신한다.

```js
const socket = io(`${BACKEND_ORIGIN}/canvas`, {
  path: '/realtime',
  transports: ['websocket'],
  withCredentials: true,
  auth: { canvasKey: `season:${season.id}` },
});
```

ready 뒤 `canvas:sync`로 시즌 그림을 복구한다. `season:state`가 종료를 알리면 이벤트의 head까지 다시 sync한다. 취소가 확정되면 비개설자 연결은 `canvas_unavailable` reset 뒤 종료되며, 개설자는 취소 상태를 읽기 전용으로 계속 확인할 수 있다. 상세 연결·재시도 흐름은 [실시간 연결 가이드](../canvas/realtime-connection.md), sync 흐름은 [그림 동기화 가이드](../canvas/drawing-sync.md)를 따른다.

시즌 캔버스는 관람·sync와 참가자의 그림 입력을 구현했다. 운영 기본값 `SEASON_DRAWING_ENABLED=false`에서는 `connection:ready.canDraw`가 false이고 append가 거절된다. 검증된 환경에서 flag를 true로 설정한 뒤에만 입력을 연다. 예약·종료·취소 상태는 flag와 관계없이 읽기 전용이다. NFT·cNFT 발행과 결제는 별도 후속 설계가 필요하다.
