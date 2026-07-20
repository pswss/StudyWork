-- 자동 문제 추출의 연속 실패 횟수. 영구 오류 파일을 무한 재시도하지 않도록 제한한다.
ALTER TABLE materials ADD COLUMN book_retry_count INTEGER NOT NULL DEFAULT 0;
