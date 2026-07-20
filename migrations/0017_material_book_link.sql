-- 자료에서 자동 추출한 문제(내부 book)를 자료에 연결 — 자료 삭제 시 그 문제·해설까지 연쇄 삭제
ALTER TABLE materials ADD COLUMN book_id INTEGER;
