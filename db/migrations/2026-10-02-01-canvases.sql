-- 메인과 시즌의 공통 캔버스 설정을 저장한다. 획과 참가 기록은 후속 기능에서 연결한다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.canvases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type varchar(20) NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    stroke_limit_per_user integer NOT NULL,
    starts_at timestamptz,
    ends_at timestamptz,
    last_sequence bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT canvases_type_check CHECK (type IN ('main', 'season')),
    CONSTRAINT canvases_dimensions_check CHECK (width > 0 AND height > 0),
    CONSTRAINT canvases_last_sequence_check CHECK (last_sequence >= 0),
    CONSTRAINT canvases_main_rules_check CHECK (
        type <> 'main'
        OR (
            width = 10000 AND height = 10000
            AND stroke_limit_per_user = 1
            AND starts_at IS NULL AND ends_at IS NULL
        )
    ),
    -- CHECK는 NULL 결과를 거절하지 않으므로 시즌의 양쪽 시각을 명시적으로 요구한다.
    CONSTRAINT canvases_season_rules_check CHECK (
        type <> 'season'
        OR (
            stroke_limit_per_user BETWEEN 1 AND 1000
            AND starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND isfinite(starts_at) AND isfinite(ends_at)
            AND starts_at < ends_at
        )
    )
);

-- 메인은 하나만 유지하고 시즌은 여러 개 생성할 수 있다.
CREATE UNIQUE INDEX IF NOT EXISTS canvases_single_main
    ON public.canvases (type) WHERE type = 'main';

ALTER TABLE public.canvases ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.canvases IS
    '메인과 시즌의 공통 캔버스 설정. 캔버스 ID는 확정 획과 참가 기록을 연결할 때 유지한다.';
COMMENT ON COLUMN public.canvases.type IS
    'main은 단일 상시 캔버스, season은 기간과 참가 규칙을 가진 캔버스.';
COMMENT ON COLUMN public.canvases.width IS
    '확대·축소·회전 전 원본 캔버스의 픽셀 너비.';
COMMENT ON COLUMN public.canvases.height IS
    '확대·축소·회전 전 원본 캔버스의 픽셀 높이.';
COMMENT ON COLUMN public.canvases.stroke_limit_per_user IS
    '계정당 확정 가능한 획 수. 메인은 평생 1획, 시즌은 해당 캔버스에서 1~1000획.';
COMMENT ON COLUMN public.canvases.starts_at IS
    '시즌에서 그리기를 시작할 수 있는 시각. 메인은 NULL.';
COMMENT ON COLUMN public.canvases.ends_at IS
    '시즌에서 그리기를 종료하는 시각. 메인은 NULL.';
COMMENT ON COLUMN public.canvases.last_sequence IS
    '해당 캔버스에 확정 저장된 마지막 획 순서. 초기값은 0이며 획 저장과 같은 트랜잭션에서 증가시킨다.';

-- 다시 실행해도 기존 메인의 ID와 확정 순서를 바꾸지 않는다.
INSERT INTO public.canvases (type, width, height, stroke_limit_per_user)
VALUES ('main', 10000, 10000, 1)
ON CONFLICT (type) WHERE type = 'main' DO NOTHING;

COMMIT;
