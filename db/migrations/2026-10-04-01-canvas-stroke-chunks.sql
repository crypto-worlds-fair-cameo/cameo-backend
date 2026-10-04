-- 실시간 좌표 묶음을 캔버스 전체 순서로 저장해 재시작 후에도 sync가 복구할 수 있게 한다.
BEGIN;

-- last_sequence는 완료된 획 순서를 유지하고, 좌표 묶음 순서는 별도 컬럼으로 관리한다.
ALTER TABLE public.canvases
    ADD COLUMN IF NOT EXISTS last_chunk_sequence bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.canvases'::regclass
          AND conname = 'canvases_last_chunk_sequence_check'
    ) THEN
        ALTER TABLE public.canvases
            ADD CONSTRAINT canvases_last_chunk_sequence_check
            CHECK (last_chunk_sequence >= 0);
    END IF;
END $$;

-- 복합 FK가 사용 기록과 청크의 canvas_id가 같은지 DB에서 보장한다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.canvas_stroke_usages'::regclass
          AND conname = 'canvas_stroke_usages_canvas_id_id_unique'
    ) THEN
        ALTER TABLE public.canvas_stroke_usages
            ADD CONSTRAINT canvas_stroke_usages_canvas_id_id_unique
            UNIQUE (canvas_id, id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.canvas_stroke_chunks (
    canvas_id uuid NOT NULL,
    stroke_usage_id uuid NOT NULL,
    sequence bigint NOT NULL,
    chunk_index integer NOT NULL,
    brush jsonb NOT NULL,
    points jsonb NOT NULL,
    is_final boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT canvas_stroke_chunks_canvas_sequence_unique
        UNIQUE (canvas_id, sequence),
    CONSTRAINT canvas_stroke_chunks_usage_chunk_unique
        UNIQUE (stroke_usage_id, chunk_index),
    CONSTRAINT canvas_stroke_chunks_usage_fkey
        FOREIGN KEY (canvas_id, stroke_usage_id)
        REFERENCES public.canvas_stroke_usages (canvas_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT canvas_stroke_chunks_sequence_check CHECK (sequence > 0),
    CONSTRAINT canvas_stroke_chunks_chunk_index_check
        CHECK (chunk_index BETWEEN 0 AND 1000000),
    -- 앱 검증을 대신하지 않고 손상된 JSON의 핵심 형태와 브러시 범위만 차단한다.
    CONSTRAINT canvas_stroke_chunks_brush_check CHECK (
        jsonb_typeof(brush) = 'object'
        AND COALESCE(brush->>'type' IN ('round', 'flat', 'airbrush'), false)
        AND COALESCE(brush->>'color' ~ '^#[0-9A-F]{6}$', false)
        AND CASE WHEN jsonb_typeof(brush->'size') = 'number'
            THEN (brush->>'size')::numeric BETWEEN 1 AND 200
            ELSE false END
        AND CASE WHEN jsonb_typeof(brush->'opacity') = 'number'
            THEN (brush->>'opacity')::numeric BETWEEN 0.01 AND 1
            ELSE false END
        AND CASE WHEN jsonb_typeof(brush->'version') = 'number'
            THEN (brush->>'version')::numeric = 1
            ELSE false END
    ),
    CONSTRAINT canvas_stroke_chunks_points_check CHECK (
        CASE WHEN jsonb_typeof(points) = 'array'
            THEN jsonb_array_length(points) <= 128
            ELSE false END
    ),
    CONSTRAINT canvas_stroke_chunks_created_at_check CHECK (isfinite(created_at))
);

-- 브라우저는 청크를 직접 읽거나 바꾸지 않고 소켓 서버를 통해서만 접근한다.
ALTER TABLE public.canvas_stroke_chunks ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.canvases.last_chunk_sequence IS
    'DB에 연속 저장된 마지막 좌표 묶음 순서. 완료된 획 순서인 last_sequence와 별도로 증가한다.';
COMMENT ON TABLE public.canvas_stroke_chunks IS
    '실시간으로 전달한 좌표 묶음의 영속 기록. canvas_id와 sequence 순서로 sync를 복구한다.';
COMMENT ON COLUMN public.canvas_stroke_chunks.canvas_id IS
    '좌표 묶음이 속한 캔버스. stroke_usage_id의 캔버스와 같아야 한다.';
COMMENT ON COLUMN public.canvas_stroke_chunks.stroke_usage_id IS
    '첫 좌표 승인 시 생성한 획 사용 기록. 같은 획의 청크를 묶고 중복을 판별한다.';
COMMENT ON COLUMN public.canvas_stroke_chunks.sequence IS
    '캔버스 전체 좌표 묶음의 1부터 시작하는 연속 순서.';
COMMENT ON COLUMN public.canvas_stroke_chunks.chunk_index IS
    '한 획 안에서 0부터 증가하는 클라이언트 전송 순서.';
COMMENT ON COLUMN public.canvas_stroke_chunks.brush IS
    '해당 획의 종류, 크기, 색상, 투명도와 재현 옵션을 담은 검증된 JSON.';
COMMENT ON COLUMN public.canvas_stroke_chunks.points IS
    '해당 묶음의 캔버스 좌표 배열. 한 행에 최대 128개를 저장한다.';
COMMENT ON COLUMN public.canvas_stroke_chunks.is_final IS
    '해당 묶음이 획의 마지막 전송이면 true.';
COMMENT ON COLUMN public.canvas_stroke_chunks.created_at IS
    '좌표 묶음을 DB에 처음 저장한 서버 시각.';

COMMIT;
