-- 서버가 첫 좌표를 승인할 때 획 사용을 기록한다. 중간 연결 종료도 사용 횟수에 포함한다.
-- 마이그레이션은 저장 구조를 만들고, 소켓의 append 기능이 최초 사용·완료를 기록한다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.canvas_stroke_usages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canvas_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_stroke_id uuid NOT NULL,
    used_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamptz,
    CONSTRAINT canvas_stroke_usages_canvas_id_fkey FOREIGN KEY (canvas_id)
        REFERENCES public.canvases (id) ON DELETE RESTRICT,
    CONSTRAINT canvas_stroke_usages_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE RESTRICT,
    -- ACK 유실과 재접속으로 같은 획을 재전송해도 사용 횟수가 늘어나지 않게 한다.
    -- 이 인덱스의 앞 두 컬럼으로 캔버스별 유저의 사용 여부와 횟수도 조회한다.
    CONSTRAINT canvas_stroke_usages_stroke_unique
        UNIQUE (canvas_id, user_id, client_stroke_id),
    CONSTRAINT canvas_stroke_usages_time_check CHECK (
        isfinite(used_at)
        AND (
            completed_at IS NULL
            OR (isfinite(completed_at) AND completed_at >= used_at)
        )
    )
);

-- 브라우저의 직접 조회·변경은 허용하지 않고 기존 서버 DB 접근 방식으로 관리한다.
ALTER TABLE public.canvas_stroke_usages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.canvas_stroke_usages IS
    '캔버스별 계정의 획 사용 기록. 완료 여부와 무관하게 모든 행을 사용 횟수에 포함한다. 좌표와 브러시는 별도로 관리한다.';
COMMENT ON COLUMN public.canvas_stroke_usages.canvas_id IS
    '획을 사용한 캔버스. 메인은 평생, 시즌은 해당 캔버스의 사용 횟수를 판별한다.';
COMMENT ON COLUMN public.canvas_stroke_usages.user_id IS
    '서버가 인증한 사용자. 클라이언트가 지정한 사용자 ID를 신뢰하지 않는다.';
COMMENT ON COLUMN public.canvas_stroke_usages.client_stroke_id IS
    '클라이언트가 획 시작 시 생성한 UUID. 같은 캔버스와 사용자 범위에서 재전송을 식별한다.';
COMMENT ON COLUMN public.canvas_stroke_usages.used_at IS
    '첫 좌표를 승인하며 사용을 확정한 서버 시각. 중단된 획도 기록을 유지한다.';
COMMENT ON COLUMN public.canvas_stroke_usages.completed_at IS
    '마지막 좌표 묶음의 isFinal을 승인한 서버 시각. 진행 중이거나 중단된 획은 NULL이며 사용 횟수에는 포함한다.';

-- 중복 획은 UNIQUE로 막지만 캔버스 설정의 최대 획 수는 첫 승인 트랜잭션에서 잠금과 함께 검사해야 한다.
COMMIT;
