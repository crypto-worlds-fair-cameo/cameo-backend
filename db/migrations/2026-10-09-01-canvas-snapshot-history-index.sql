-- READY 스냅샷 히스토리를 캔버스별 캡처 시각·ID 최신순으로 조회한다.
BEGIN;

CREATE INDEX IF NOT EXISTS canvas_snapshots_history_ready_idx
    ON public.canvas_snapshots (canvas_id, captured_at DESC, id DESC)
    WHERE status = 'READY';

COMMIT;
