-- 그림·도형 딸린 항목 표시 (원본 페이지 이미지를 인라인으로 보여주기 위함)
ALTER TABLE book_items ADD COLUMN has_figure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN has_figure INTEGER NOT NULL DEFAULT 0;

-- 데이터 정리: 문제집 삭제 후에도 돌던 추출 잡이 insert한 고아 항목 제거
DELETE FROM book_items WHERE book_id NOT IN (SELECT id FROM books);
