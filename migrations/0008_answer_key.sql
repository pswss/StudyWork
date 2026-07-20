-- 빠른답표(정답만 나열)를 해설과 구분하는 '정답' 카테고리 추가.
-- SQLite는 CHECK 수정이 불가하므로 테이블 재생성으로 교체한다.
CREATE TABLE book_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('개념','팁','문제','해설','정답')),
  number TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  page INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO book_items_new SELECT * FROM book_items;
DROP TABLE book_items;
ALTER TABLE book_items_new RENAME TO book_items;
CREATE INDEX idx_book_items_book ON book_items(book_id, category);

-- 기존에 해설로 잘못 들어간 정답표 스텁을 정답 카테고리로 이관
UPDATE book_items SET category = '정답', content = '' WHERE category = '해설' AND content = '정답표';
