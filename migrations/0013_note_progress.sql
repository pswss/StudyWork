-- 단권화 진행률(%) — 청크 완료 기준, 폴링 UI 표시용
ALTER TABLE notes ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
