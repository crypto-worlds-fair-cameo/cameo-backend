-- 시즌 공개 설명을 안내문으로 쓸 수 있도록 1000자까지 저장한다.
BEGIN;

ALTER TABLE public.seasons
    ALTER COLUMN description TYPE varchar(1000);

ALTER TABLE public.seasons
    DROP CONSTRAINT seasons_description_check;

ALTER TABLE public.seasons
    ADD CONSTRAINT seasons_description_check CHECK (
        description IS NULL
        OR (
            length(description) BETWEEN 1 AND 1000
            AND description = btrim(description)
        )
    );

COMMENT ON COLUMN public.seasons.description IS
    '앞뒤 공백을 제거한 1~1000자 공개 설명. 설명이 없으면 NULL.';

COMMIT;
