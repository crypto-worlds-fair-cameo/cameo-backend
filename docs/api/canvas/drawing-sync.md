# 메인 캔버스 그림 동기화 프론트 가이드

연결은 [실시간 연결 가이드](realtime-connection.md)를 따른다. 요청·응답과 입력 한도는 [소켓 이벤트 타입](../../../src/modules/canvas/resources/canvas-connections/canvas-events.ts)과 [좌표 묶음 계약](../../../src/modules/canvas/resources/canvas-stroke/canvas-stroke.ts)을 기준으로 한다.

그림 이벤트는 `stroke:append`, `stroke:preview`, `canvas:sync`만 사용한다. 좌표 묶음을 메모리에 유지하며 DB 저장과 계정당 평생 획 제한은 제공하지 않는다. 서버 재시작 시 그림이 초기화된다. 한 소켓 서버 프로세스 기준으로 연결한다.

## 그리기와 전송

포인터를 누르면 UUID를 만들고 브러시를 고정한다. 화면 확대·이동을 역변환한 원본 캔버스 좌표를 모은다. 본인 화면에는 즉시 그린다. 모든 프론트는 같은 버전의 렌더러를 사용한다. Flat은 고정 각도, Airbrush는 같은 seed와 획 시작 기준 시각으로 재현한다. 분사 순서는 프레임 수나 패킷 경계에 의존하지 않는다.

첫 append와 마지막 append에서 세션을 검증한다. 중간 좌표에는 해당 연결·획의 인증 상태를 재사용한다. 연결이 끊기면 인증 캐시를 비우며 재접속한 획은 다시 인증한다. 시작과 종료를 하나의 묶음으로 보내는 짧은 획은 한 번의 인증으로 처리한다.

ready 이후 요청마다 ACK를 전달한다. 약 50ms마다 새 좌표를 묶고, 이전 묶음의 마지막 좌표를 다음 묶음에 포함한다. 한 묶음의 ACK를 기다리는 동안에는 추가 좌표를 프론트에서 모은다. 마우스를 놓으면 남은 좌표를 즉시 보내면서 `isFinal: true`로 마친다. 남은 좌표가 없으면 마지막 묶음은 빈 points를 허용한다.

```js
async function request(socket, event, payload) {
  if (!socket.connected) throw new Error('Canvas is disconnected.');
  const response = await socket.timeout(5000).emitWithAck(event, payload);
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), {
      code: response.error.code,
    });
  }
  return response.data;
}

const stroke = {
  clientStrokeId: crypto.randomUUID(),
  brush: {
    type: 'round', size: 12, color: '#ED4242', opacity: 1, version: 1,
  },
};

const first = await request(socket, 'stroke:append', {
  ...stroke,
  chunkIndex: 0,
  points: [{ x: 100, y: 200 }, { x: 104, y: 203 }],
  isFinal: false,
});
acceptPreview(first.preview);

const last = await request(socket, 'stroke:append', {
  ...stroke,
  chunkIndex: 1,
  points: [{ x: 104, y: 203 }, { x: 110, y: 208 }],
  isFinal: true,
});
acceptPreview(last.preview);
```

좌표 묶음은 chunkIndex를 0부터 순서대로 증가시킨다. ACK 시간 초과는 수신 실패를 뜻하지 않는다. 마지막으로 ACK를 확인하지 못한 묶음은 같은 ID·chunkIndex·데이터로 재전송한다. 끊긴 동안 Socket.IO 기본 버퍼에 좌표를 쌓지 않는다. 메모리 용량이 찼다는 거절을 받으면 전송을 멈추고 이유를 표시한다. 이전 그림을 자동으로 지우거나 저장하지 않는다.

## 수신과 표시

```js
socket.on('stroke:preview', acceptPreview);
```

서버 방송은 제출자를 제외한다. 제출자는 ACK의 preview를 동일한 수신 경로에 넣어 자신의 묶음도 서버 순서에 포함한다. 사용자 ID와 획 ID를 함께 키로 사용한다. 같은 epoch·sequence는 한 번만 반영한다. 서로 다른 사용자의 획이 겹쳐도 같게 보이도록 좌표 묶음을 sequence 순서로 재생한다. 로컬 즉시 표시와 서버 순서 반영이 중복되지 않도록 렌더러에서 구분한다.

`isFinal`은 획 종료 표시이며 DB 저장 성공을 뜻하지 않는다. 중단된 획의 수신 좌표도 현재 메모리 그림에 포함된다. 진행 중 방송이 유실되면 sync로 복구한다.

## 최초 접속과 재접속 복구

수신 리스너를 먼저 등록한다. 최초 접속은 0부터, 재접속은 현재 epoch와 마지막으로 연속 반영한 sequence부터 조회한다. 조회 중 들어오는 preview도 epoch별 sequence 버퍼에 넣는다. 서버가 재시작됐거나 epoch를 모르는 조회에는 reset 안내와 첫 페이지가 온다. 새 epoch라면 기존 그림·cursor·전송 대기를 비우고, 같은 epoch의 수신 버퍼와 복구 페이지를 합친다.

```js
async function recover(socket, currentEpoch, lastAppliedSequence) {
  let epoch = currentEpoch;
  let cursor = lastAppliedSequence;
  let head;
  for (;;) {
    let page;
    try {
      page = await request(socket, 'canvas:sync', {
        ...(epoch === undefined ? {} : { epoch }),
        afterSequence: cursor,
        ...(head === undefined ? {} : { throughSequence: head }),
        limit: 50,
      });
    } catch (error) {
      if (error.code !== 'RATE_LIMITED') throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (page.reset) resetCanvasForEpoch(page.epoch);
    epoch = page.epoch;
    head = page.headSequence;
    for (const preview of page.previews) acceptPreview(preview);
    cursor = page.nextSequence;
    if (!page.hasMore) return;
  }
}
```

한 번에 복구 하나만 실행한다. 연결이 바뀌면 이전 연결에서 진행한 응답을 폐기한다. sequence가 비면 복구하고, 연결 중에도 약 5초마다 마지막 반영 순서부터 조회해 마지막 방송 유실을 보완한다. sync는 DB를 조회하지 않는다. head 이후 좌표는 수신 버퍼에서 합치거나 다음 복구에서 조회한다.

## 프론트 확인

1. 두 브라우저에서 같은 위치·브러시·색상으로 그림이 보이는지 확인한다.
2. 포인터 종료가 마지막 append의 isFinal로 전달되는지 확인한다.
3. ACK 시간 초과 후 같은 묶음을 재전송해 중복되지 않는지 확인한다.
4. 새 접속·재접속 뒤 현재 메모리 그림이 같은 순서로 복원되는지 확인한다.
5. 서버 재시작 후 이전 epoch의 그림과 재전송 대기가 초기화되는지 확인한다.
