-- 해설지: 문제집 단위로 업로드한 해설을 번호별로 저장
CREATE TABLE solution_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE solutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_solutions_book ON solutions(book_id);
