-- 그림 딸린 항목의 세로 구간("top,bottom" 페이지 높이 비율) — 전체 페이지 대신 해당 부분만 잘라 표시
ALTER TABLE book_items ADD COLUMN figure_box TEXT;
ALTER TABLE questions ADD COLUMN figure_box TEXT;
