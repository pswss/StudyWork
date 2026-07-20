-- 단권화 백그라운드 처리 상태 (processing/ready/error)
ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
