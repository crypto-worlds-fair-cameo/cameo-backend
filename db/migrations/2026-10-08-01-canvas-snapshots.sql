-- 캔버스 스냅샷 PNG와 이어 그리기 상태 파일의 공개 메타데이터를 저장한다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.canvas_snapshots (
    id uuid PRIMARY KEY,
    canvas_id uuid NOT NULL REFERENCES public.canvases (id) ON DELETE RESTRICT,
    through_sequence bigint NOT NULL,
    renderer_version text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    status text NOT NULL,
    is_final boolean NOT NULL DEFAULT false,
    image_key text NOT NULL,
    continuation_key text NOT NULL,
    image_bytes bigint NOT NULL,
    continuation_bytes bigint NOT NULL,
    image_sha256 text NOT NULL,
    continuation_sha256 text NOT NULL,
    continuation_schema_version integer NOT NULL,
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT canvas_snapshots_through_sequence_check CHECK (through_sequence >= 0),
    CONSTRAINT canvas_snapshots_dimensions_check CHECK (width > 0 AND height > 0),
    CONSTRAINT canvas_snapshots_status_check CHECK (status IN ('READY', 'INVALID')),
    CONSTRAINT canvas_snapshots_image_key_check CHECK (
        image_key ~ '^snapshots/(main|seasons)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/image\.png$'
        AND image_key !~ '(?:^|/)\.\.(?:/|$)'
    ),
    CONSTRAINT canvas_snapshots_continuation_key_check CHECK (
        continuation_key ~ '^snapshots/(main|seasons)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/continuation\.json$'
        AND continuation_key !~ '(?:^|/)\.\.(?:/|$)'
    ),
    CONSTRAINT canvas_snapshots_file_pair_check CHECK (
        regexp_replace(image_key, '/image\.png$', '') =
        regexp_replace(continuation_key, '/continuation\.json$', '')
    ),
    CONSTRAINT canvas_snapshots_image_bytes_check CHECK (image_bytes > 0),
    CONSTRAINT canvas_snapshots_continuation_bytes_check CHECK (continuation_bytes > 0),
    CONSTRAINT canvas_snapshots_image_sha256_check CHECK (
        image_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT canvas_snapshots_continuation_sha256_check CHECK (
        continuation_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT canvas_snapshots_continuation_schema_check CHECK (
        continuation_schema_version = 1
    ),
    CONSTRAINT canvas_snapshots_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT canvas_snapshots_captured_at_check CHECK (isfinite(captured_at))
);

CREATE UNIQUE INDEX IF NOT EXISTS canvas_snapshots_image_key_unique
    ON public.canvas_snapshots (image_key);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_snapshots_continuation_key_unique
    ON public.canvas_snapshots (continuation_key);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_snapshots_ready_boundary_unique
    ON public.canvas_snapshots (canvas_id, through_sequence, renderer_version)
    WHERE status = 'READY';
CREATE UNIQUE INDEX IF NOT EXISTS canvas_snapshots_final_ready_unique
    ON public.canvas_snapshots (canvas_id)
    WHERE is_final = true AND status = 'READY';
CREATE INDEX IF NOT EXISTS canvas_snapshots_ready_lookup_idx
    ON public.canvas_snapshots (
        canvas_id,
        renderer_version,
        through_sequence DESC,
        created_at DESC,
        id DESC
    )
    WHERE status = 'READY';

ALTER TABLE public.canvas_snapshots ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.canvas_snapshots IS
    '캔버스 복구에 사용하는 PNG와 이어 그리기 상태 파일의 공개 메타데이터.';
COMMENT ON COLUMN public.canvas_snapshots.through_sequence IS
    '스냅샷이 포함한 마지막 좌표 묶음 순서 N.';
COMMENT ON COLUMN public.canvas_snapshots.renderer_version IS
    'PNG와 continuation 상태를 만든 렌더러 의미 버전.';
COMMENT ON COLUMN public.canvas_snapshots.status IS
    'READY는 복구 후보, INVALID는 손상 또는 무효화된 결과.';
COMMENT ON COLUMN public.canvas_snapshots.is_final IS
    '시즌 종료 이후 최종 작품을 가리키는 스냅샷 표시.';
COMMENT ON COLUMN public.canvas_snapshots.image_key IS
    '저장 루트 기준 PNG 상대 경로.';
COMMENT ON COLUMN public.canvas_snapshots.continuation_key IS
    '저장 루트 기준 continuation JSON 상대 경로.';
COMMENT ON COLUMN public.canvas_snapshots.image_sha256 IS
    'PNG 바이트의 SHA-256 소문자 hex.';
COMMENT ON COLUMN public.canvas_snapshots.continuation_sha256 IS
    'continuation JSON 바이트의 SHA-256 소문자 hex.';

COMMIT;
