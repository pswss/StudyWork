ALTER TABLE questions ADD COLUMN figure_description TEXT;
ALTER TABLE materials ADD COLUMN figure_backfill_pending INTEGER NOT NULL DEFAULT 0
  CHECK (figure_backfill_pending IN (0, 1));

-- 이전 추출 캐시는 figure_description 계약을 거치지 않았으므로 재사용하지 않는다.
DELETE FROM book_extraction_chunks;

-- 기존 그림 문항도 서버 부팅 시 상주 재시도 워크플로우가 원본에서 자동 재추출한다.
-- 새 결과가 완성되기 전까지 현재 문제와 학습 통계는 그대로 제공된다.
UPDATE materials
SET pending_to_book = 1, book_retry_count = 0, figure_backfill_pending = 1
WHERE status = 'ready'
  AND r2_key IS NOT NULL
  AND book_id IN (
    SELECT DISTINCT book_id FROM questions
    WHERE has_figure = 1 AND figure_description IS NULL AND book_id IS NOT NULL
  );
