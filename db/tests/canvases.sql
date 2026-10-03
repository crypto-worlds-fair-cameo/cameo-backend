-- 마이그레이션을 적용한 전용 테스트 DB에서 실행한다.
-- 제약 검증은 롤백하고, 재실행 검증 후에는 메인의 원래 순서를 복원한다.
-- 실행 예: psql -X -v ON_ERROR_STOP=1 -d <test-database> -f db/tests/canvases.sql
BEGIN;

DO $$
DECLARE
    main_canvas public.canvases%ROWTYPE;
    invalid_canvas record;
    next_sequence bigint;
BEGIN
    -- 초기 데이터가 빠지거나 메인 규칙이 달라지면 첫 화면을 구성할 수 없다.
    SELECT * INTO STRICT main_canvas FROM public.canvases WHERE type = 'main';
    IF main_canvas.width <> 10000 OR main_canvas.height <> 10000
        OR main_canvas.stroke_limit_per_user <> 1 OR main_canvas.last_sequence <> 0
        OR main_canvas.starts_at IS NOT NULL OR main_canvas.ends_at IS NOT NULL THEN
        RAISE EXCEPTION 'Main canvas seed does not match the drawing rules';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.canvases'::regclass) THEN
        RAISE EXCEPTION 'Canvas row level security is not enabled';
    END IF;

    -- 메인과 함께 크기·기간·획 제한이 서로 다른 시즌을 여러 개 저장할 수 있어야 한다.
    INSERT INTO public.canvases (type, width, height, stroke_limit_per_user, starts_at, ends_at)
    VALUES
        ('season', 640, 480, 1, '2026-10-01 00:00:00+00', '2026-10-02 00:00:00+00'),
        ('season', 2048, 1024, 1000, '2026-11-01 00:00:00+00', '2026-12-01 00:00:00+00');

    BEGIN
        INSERT INTO public.canvases (type, width, height, stroke_limit_per_user)
        VALUES ('main', 10000, 10000, 1);
        RAISE EXCEPTION 'A second main canvas was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    -- NULL 기간, 범위 밖 획 수, 잘못된 크기·종류·확정 순서를 DB가 거절하는지 확인한다.
    FOR invalid_canvas IN
        SELECT * FROM (VALUES
            ('unknown', 10000, 10000, 1, NULL::timestamptz, NULL::timestamptz, 0::bigint),
            ('season', 0, 10000, 1, '2026-10-01'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, -1, 1, '2026-10-01'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 0, '2026-10-01'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1001, '2026-10-01'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, NULL::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '2026-10-01'::timestamptz, NULL::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '2026-10-02'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '2026-10-03'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '-infinity'::timestamptz, '2026-10-02'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '2026-10-01'::timestamptz, 'infinity'::timestamptz, 0::bigint),
            ('season', 10000, 10000, 1, '2026-10-01'::timestamptz, '2026-10-02'::timestamptz, -1::bigint)
        ) AS cases(type, width, height, stroke_limit, starts_at, ends_at, last_sequence)
    LOOP
        BEGIN
            INSERT INTO public.canvases (type, width, height, stroke_limit_per_user, starts_at, ends_at, last_sequence)
            VALUES (invalid_canvas.type, invalid_canvas.width, invalid_canvas.height,
                invalid_canvas.stroke_limit, invalid_canvas.starts_at, invalid_canvas.ends_at,
                invalid_canvas.last_sequence);
            RAISE EXCEPTION 'Invalid canvas was accepted: %', row_to_json(invalid_canvas);
        EXCEPTION WHEN check_violation THEN
            NULL;
        END;
    END LOOP;

    -- 기존 메인을 갱신해서 단일성 인덱스에 가려지지 않는 메인 규칙도 검증한다.
    BEGIN
        UPDATE public.canvases SET width = 9999 WHERE id = main_canvas.id;
        RAISE EXCEPTION 'Invalid main dimensions were accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE public.canvases SET height = 9999 WHERE id = main_canvas.id;
        RAISE EXCEPTION 'Invalid main dimensions were accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE public.canvases SET stroke_limit_per_user = 2 WHERE id = main_canvas.id;
        RAISE EXCEPTION 'Multiple main strokes per user were accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE public.canvases SET starts_at = '2026-10-01' WHERE id = main_canvas.id;
        RAISE EXCEPTION 'A main canvas start time was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE public.canvases SET ends_at = '2026-10-02' WHERE id = main_canvas.id;
        RAISE EXCEPTION 'A main canvas end time was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE public.canvases SET last_sequence = last_sequence + 1
    WHERE id = main_canvas.id RETURNING last_sequence INTO next_sequence;
    IF next_sequence <> 1 THEN
        RAISE EXCEPTION 'The first confirmed sequence was not 1';
    END IF;
END;
$$;

ROLLBACK;

-- 초기 데이터가 생긴 뒤 다시 배포해도 메인의 ID와 누적 순서가 보존되어야 한다.
CREATE TEMP TABLE canvas_seed_before AS
SELECT id, last_sequence FROM public.canvases WHERE type = 'main';
UPDATE public.canvases SET last_sequence = 7 WHERE type = 'main';

\ir ../migrations/2026-10-02-01-canvases.sql

DO $$
BEGIN
    IF (SELECT count(*) FROM public.canvases WHERE type = 'main') <> 1
        OR NOT EXISTS (
            SELECT 1 FROM public.canvases c
            JOIN canvas_seed_before b ON b.id = c.id
            WHERE c.type = 'main' AND c.last_sequence = 7
        ) THEN
        RAISE EXCEPTION 'Migration rerun changed the main identity or sequence';
    END IF;
END;
$$;

UPDATE public.canvases c SET last_sequence = b.last_sequence
FROM canvas_seed_before b WHERE c.id = b.id;
DROP TABLE canvas_seed_before;
