-- 시즌 설정과 누적 참가 기록을 추가하고, 기존 시즌 캔버스에 새 제품 제약을 적용한다.
BEGIN;

-- 기존 시즌 행이 새 범위를 벗어나면 데이터를 바꾸지 않고 전체 migration을 중단한다.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.canvases
        WHERE type = 'season'
          AND (
              width BETWEEN 500 AND 10000
              AND height BETWEEN 500 AND 10000
              AND (
                  stroke_limit_per_user IS NULL
                  OR stroke_limit_per_user BETWEEN 1 AND 10
              )
              AND CASE
                  WHEN starts_at IS NOT NULL AND ends_at IS NOT NULL
                      AND isfinite(starts_at) AND isfinite(ends_at)
                  THEN starts_at < ends_at
                      AND ends_at - starts_at
                          BETWEEN interval '1 hour' AND interval '30 days'
                  ELSE false
              END
          ) IS NOT TRUE
    ) THEN
        RAISE EXCEPTION
            'Existing season canvases violate the new size, stroke limit, or duration constraints.';
    END IF;
END $$;

-- 시즌의 NULL 획 제한은 무제한을 뜻한다. 메인은 아래 CHECK에서 계속 1획만 허용한다.
ALTER TABLE public.canvases
    ALTER COLUMN stroke_limit_per_user DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS canvases_dimensions_check,
    DROP CONSTRAINT IF EXISTS canvases_main_rules_check,
    DROP CONSTRAINT IF EXISTS canvases_season_rules_check;

ALTER TABLE public.canvases
    ADD CONSTRAINT canvases_dimensions_check CHECK (
        width > 0 AND height > 0
    ),
    ADD CONSTRAINT canvases_main_rules_check CHECK (
        type <> 'main'
        OR (
            width = 10000 AND height = 10000
            AND stroke_limit_per_user IS NOT NULL
            AND stroke_limit_per_user = 1
            AND starts_at IS NULL AND ends_at IS NULL
        )
    ),
    -- 시즌은 지정 범위의 크기와 기간을 가지며, NULL 획 제한은 무제한을 뜻한다.
    ADD CONSTRAINT canvases_season_rules_check CHECK (
        type <> 'season'
        OR (
            width BETWEEN 500 AND 10000
            AND height BETWEEN 500 AND 10000
            AND (
                stroke_limit_per_user IS NULL
                OR stroke_limit_per_user BETWEEN 1 AND 10
            )
            AND CASE
                WHEN starts_at IS NOT NULL AND ends_at IS NOT NULL
                    AND isfinite(starts_at) AND isfinite(ends_at)
                THEN starts_at < ends_at
                    AND ends_at - starts_at
                        BETWEEN interval '1 hour' AND interval '30 days'
                ELSE false
            END
        )
    );

-- 시즌 FK가 canvas_id뿐 아니라 type='season' 관계도 선언적으로 검증할 수 있게 한다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.canvases'::regclass
          AND conname = 'canvases_id_type_unique'
    ) THEN
        ALTER TABLE public.canvases
            ADD CONSTRAINT canvases_id_type_unique UNIQUE (id, type);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.seasons (
    canvas_id uuid PRIMARY KEY,
    canvas_type varchar(20) NOT NULL DEFAULT 'season',
    creator_id uuid NOT NULL,
    title varchar(50) NOT NULL,
    description varchar(100),
    capacity integer NOT NULL,
    cancelled_at timestamptz,
    force_ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT seasons_canvas_fkey FOREIGN KEY (canvas_id, canvas_type)
        REFERENCES public.canvases (id, type) ON DELETE RESTRICT,
    CONSTRAINT seasons_creator_id_fkey FOREIGN KEY (creator_id)
        REFERENCES public.users (id) ON DELETE RESTRICT,
    CONSTRAINT seasons_canvas_type_check CHECK (canvas_type = 'season'),
    CONSTRAINT seasons_title_check CHECK (
        length(title) BETWEEN 1 AND 50
        AND title = btrim(title)
    ),
    CONSTRAINT seasons_description_check CHECK (
        description IS NULL
        OR (
            length(description) BETWEEN 1 AND 100
            AND description = btrim(description)
        )
    ),
    CONSTRAINT seasons_capacity_check CHECK (capacity BETWEEN 2 AND 100),
    -- 취소와 강제 종료는 서로 다른 최종 상태이므로 동시에 기록하지 않는다.
    CONSTRAINT seasons_terminal_state_check CHECK (
        cancelled_at IS NULL OR force_ended_at IS NULL
    )
);

-- 개설 제한 검사는 최종 상태가 없는 시즌만 개설자별로 좁힌 뒤 캔버스 종료 시각을 판정한다.
CREATE INDEX IF NOT EXISTS seasons_open_creator_idx
    ON public.seasons (creator_id)
    WHERE cancelled_at IS NULL AND force_ended_at IS NULL;

-- 공개 목록은 취소하지 않은 시즌을 생성 역순과 ID 역순으로 조회한다.
CREATE INDEX IF NOT EXISTS seasons_public_list_idx
    ON public.seasons (created_at DESC, canvas_id DESC)
    WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS public.season_participants (
    season_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_participants_pkey PRIMARY KEY (season_id, user_id),
    CONSTRAINT season_participants_season_id_fkey FOREIGN KEY (season_id)
        REFERENCES public.seasons (canvas_id) ON DELETE RESTRICT,
    CONSTRAINT season_participants_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS season_participants_user_id_idx
    ON public.season_participants (user_id, season_id);

-- 브라우저의 직접 접근은 허용하지 않고 기존 서버 DB 접근 방식으로 관리한다.
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_participants ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.seasons IS
    '시즌 캔버스의 개설자, 공개 설명, 정원과 종료 상태. canvas_id가 시즌과 캔버스의 공통 ID다.';
COMMENT ON COLUMN public.seasons.canvas_id IS
    'type이 season인 캔버스 ID. 시즌 방의 외부 식별자로 그대로 사용한다.';
COMMENT ON COLUMN public.seasons.canvas_type IS
    '복합 FK가 연결 캔버스의 type을 검증하도록 season으로 고정한 판별자.';
COMMENT ON COLUMN public.seasons.creator_id IS
    '시즌을 개설한 사용자. 취소와 강제 종료 권한을 판정한다.';
COMMENT ON COLUMN public.seasons.title IS
    '앞뒤 공백을 제거한 1~50자 공개 제목.';
COMMENT ON COLUMN public.seasons.description IS
    '앞뒤 공백을 제거한 1~100자 공개 설명. 설명이 없으면 NULL.';
COMMENT ON COLUMN public.seasons.capacity IS
    '개설자를 포함한 누적 참가 정원. 접속 종료나 재입장으로 감소하거나 중복 증가하지 않는다.';
COMMENT ON COLUMN public.seasons.cancelled_at IS
    '시작 전 취소한 서버 시각. 취소하지 않았으면 NULL.';
COMMENT ON COLUMN public.seasons.force_ended_at IS
    '진행 중 강제 종료한 서버 시각. 예정 종료나 취소이면 NULL.';
COMMENT ON COLUMN public.seasons.created_at IS
    '시즌 생성 트랜잭션에서 기록한 서버 시각.';

COMMENT ON TABLE public.season_participants IS
    '시즌별 누적 참가 기록. 같은 사용자는 시즌마다 한 번만 등록한다.';
COMMENT ON COLUMN public.season_participants.season_id IS
    '참가한 시즌의 공통 canvas_id.';
COMMENT ON COLUMN public.season_participants.user_id IS
    '참가 자격과 정원 사용을 유지하는 사용자 ID.';
COMMENT ON COLUMN public.season_participants.joined_at IS
    '사용자의 첫 참가를 확정한 서버 시각.';

COMMENT ON COLUMN public.canvases.stroke_limit_per_user IS
    '계정당 확정 가능한 획 수. 메인은 평생 1획, 시즌은 1~10획이며 NULL이면 무제한.';

COMMIT;
