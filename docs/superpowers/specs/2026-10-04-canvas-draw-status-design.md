# 캔버스 획 사용 상태 조회 이벤트 설계

상태: 설계 초안. 이벤트와 함수는 아직 구현하지 않았다.

## 현재 상태와 범위

로컬 PostgreSQL `cameo`에 `canvas_stroke_usages` 마이그레이션을 적용했다. 캔버스·사용자·클라이언트 획 ID 조합의 고유 제약, 사용자와 캔버스 참조, 사용·완료 시각 제약, RLS를 확인했다.

기존 소켓은 획 사용 기록을 INSERT하거나 사용 횟수를 제한하지 않는다. 따라서 현재 조회 테이블은 실제 소켓 그리기 이력을 반영하지 않는다. 이 설계는 로그인한 사용자의 메인 캔버스 획 사용 상태를 조회하는 이벤트에 한정한다. 좌표 저장, 획 차감 연동, 시즌 참가 판정은 포함하지 않는다.

## 조회 방식

별도 `canvas:draw-status` 요청의 ACK로 상태를 반환한다. 최초 ready 이후와 재접속 시 프론트가 요청한다. 획 사용 기록을 남기는 기능이 연결되면 첫 append 승인 이후에도 갱신한다. 다른 사용자에게 방송하지 않는다.

접속의 `connection:ready`에 사용 상태를 합치는 방법도 가능하지만, 접속 후 상태 갱신이 필요하므로 별도 조회 이벤트를 선택한다. 기존 ready의 `canDraw`는 접속 시 인증 안내이며, 이번 설계는 이 필드의 의미를 변경하지 않는다.

## 이벤트 계약

클라이언트 요청은 ACK를 필수로 전달한다.

```js
socket.emit('canvas:draw-status', { canvasKey: 'main' }, (ack) => {
  if (ack.ok) updateDrawStatus(ack.data);
});
```

사용 전 응답:

```json
{
  "ok": true,
  "data": {
    "canvasKey": "main",
    "hasUsedStroke": false,
    "usedStrokeCount": 0,
    "strokeLimit": 1,
    "remainingStrokeCount": 1,
    "canStartStroke": true
  }
}
```

사용 후 응답:

```json
{
  "ok": true,
  "data": {
    "canvasKey": "main",
    "hasUsedStroke": true,
    "usedStrokeCount": 1,
    "strokeLimit": 1,
    "remainingStrokeCount": 0,
    "canStartStroke": false
  }
}
```

- `hasUsedStroke`: 기록 개수가 1개 이상이면 true다. 완료 여부와는 무관하다.
- `usedStrokeCount`: 해당 캔버스·사용자의 모든 사용 기록 개수다. `completed_at IS NULL`인 기록도 포함한다.
- `strokeLimit`: `canvases.stroke_limit_per_user` 값이다.
- `remainingStrokeCount`: `max(0, strokeLimit - usedStrokeCount)`다.
- `canStartStroke`: 인증된 사용자에게 남은 획 수가 있을 때 true다. 진행 중인 동일 획의 중간·마지막 append를 중단시키는 값으로 사용하지 않는다.

요청에 사용자 ID를 받지 않는다. 소켓 handshake의 세션 쿠키를 기존 인증 규칙으로 검증한 뒤 서버가 사용자 ID를 결정한다. 비로그인은 조회를 거절하며, 관람·그림 복구는 기존 방식으로 유지한다.

예상 거절 응답은 기존 ACK envelope을 따른다.

| 상황 | code | message |
| --- | --- | --- |
| 세션 없음 또는 무효 | `AUTH_REQUIRED` | `Authentication is required.` |
| 사용 불가 계정 | `USER_UNAVAILABLE` | `User is unavailable.` |
| payload가 객체가 아니거나 canvasKey가 main이 아님 | `INVALID_DRAW_STATUS` | `Canvas draw status request is invalid.` |
| 과도한 요청 | `RATE_LIMITED` | `Too many canvas requests.` |
| 메인 설정 없음 또는 DB 실패 | `REALTIME_UNAVAILABLE` | `Realtime service is temporarily unavailable.` |

## 함수와 책임

- `GetDrawStatusGateway`: payload와 ACK를 검증하고 기존 `CanvasConnections.respond`로 요청 제한·오류 응답을 처리한다. 제한은 소켓당 초당 5회, 동시에 1개 요청으로 한다.
- `GetDrawStatusUseCase.execute(token, input)`: 세션 인증으로 본인을 확인하고 메인 설정과 사용 횟수를 조회한다. 응답의 파생 값을 계산한다.
- `CanvasStrokeUsageRepository.getMainUsage(userId)`: 메인 캔버스 설정과 해당 사용자의 기록 개수를 하나의 조회로 반환한다. SQL은 `canvas_id + user_id`로 범위를 좁히며 기존 고유 인덱스의 앞 두 컬럼을 사용한다.

예정 파일은 다음과 같다.

```text
src/modules/canvas/features/get-draw-status/get-draw-status.gateway.ts
src/modules/canvas/features/get-draw-status/get-draw-status.use-case.ts
src/modules/canvas/resources/canvas-stroke-usage/canvas-stroke-usage.repository.ts
src/modules/canvas/resources/canvas-stroke-usage/canvas-stroke-usage.ts
```

이벤트 타입과 provider 등록은 기존 `canvas-events.ts`, `canvas.module.ts`에 추가한다. 외부 결과는 인증 모듈의 사용자 객체나 DB 행을 직접 반환하지 않는다.

`CanvasConnections.respond`의 지원 이벤트 타입과 `createMessageLimit`의 지원 목록에도 이벤트를 추가한다. 이 작업이 빠지면 정상 조회 요청이 미지원 이벤트로 집계된다. 조회에서는 접속 시 viewer나 진행 중 획의 인증 캐시를 재사용하지 않고 현재 세션을 확인한다.

## 기록 연동의 전제

조회는 읽기 전용이며 획을 차감하지 않는다. 별도 boolean은 저장하지 않는다. 서버 재시작 뒤에도 DB 기록은 유지되지만 현재 메모리 그림은 초기화된다.

실제 제한을 연결할 때는 첫 유효 좌표를 승인하기 전에 같은 캔버스·사용자 범위에서 사용 횟수 확인과 INSERT를 하나의 트랜잭션으로 처리해야 한다. 동시에 여러 탭이 시작할 수 있으므로 검사와 기록을 잠금으로 직렬화한다. 기록 후 중간에 연결이 끊겨도 사용을 되돌리지 않는다. 정상 종료 시 기존 기록의 `completed_at`을 갱신한다.

조회 결과는 새 획을 시작할 수 있다는 예약이나 보장이 아니다. 프론트는 최신 상태로 시작 버튼을 표시하되 첫 append의 서버 판정을 따라야 한다. 사용 기록 연동이 구현되기 전에는 이 이벤트만으로 획 제한이 집행되지 않는다.

## 구현 시 검증

1. 기록이 없는 인증 사용자는 사용 횟수 0, 남은 획 1을 받는다.
2. 완료 시각이 없는 기록도 사용 횟수에 포함한다.
3. 다른 캔버스와 다른 사용자의 기록은 포함하지 않는다.
4. 로그아웃·세션 폐기·사용 불가 계정과 잘못된 요청을 거절한다.
5. 조회 전후 기록 개수가 같고, 응답이 다른 소켓에 방송되지 않는다.
6. 조회 제한과 재접속 후 재조회가 기존 소켓 흐름에 맞게 동작한다.
