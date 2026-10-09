# 캔버스 히스토리 조회

메인 캔버스와 시즌 캔버스 모두 캔버스 ID로 저장된 스냅샷을 조회한다. 상세 계약은 Swagger의 `Canvas` 태그에서 확인한다.

첫 요청에서는 커서를 생략하고, 더 보기를 누르면 이전 응답의 `nextCursor`를 그대로 전달한다. 최신 그림을 다시 확인하려면 첫 페이지부터 다시 조회한다.

```ts
const apiBase = 'http://localhost:5000/api';

async function loadHistory(canvasId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor !== undefined) query.set('cursor', cursor);

  const response = await fetch(
    `${apiBase}/canvases/${encodeURIComponent(canvasId)}/history?${query}`,
    { credentials: 'include' },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
  return result.data;
}

const first = await loadHistory(canvasId);
// items의 imageUrl을 이미지로 표시하고 capturedAt을 사용자 시간대로 표시한다.
renderHistory(first.items);

if (first.hasNext) {
  const next = await loadHistory(canvasId, first.nextCursor);
  appendHistory(next.items);
}
```

취소된 시즌을 개설자로 조회하려면 로그인 세션 쿠키가 필요하다. 페이지 이동 중 시즌의 공개 상태가 바뀌면 조회가 실패할 수 있으므로 기존 화면의 오류 처리 흐름을 적용한다.
