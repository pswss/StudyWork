-- 자동 문제집화가 사용량 한도·일시 오류로 못 돈 자료 표시 — 서버 상주 루프가 이어서 처리 (빠짐없이)
ALTER TABLE materials ADD COLUMN pending_to_book INTEGER NOT NULL DEFAULT 0;
