-- 분석 진행률(%) — 페이지 청크 완료 기준
ALTER TABLE book_files ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
