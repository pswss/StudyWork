-- 문제집 v2: 해설 전용 구조를 문제집(개념·팁·문제·해설 분류) 구조로 재설계.
-- v1(solution_books/solutions)은 추출 품질 문제로 데이터 가치가 없어 드롭한다.
DROP TABLE IF EXISTS solutions;
DROP TABLE IF EXISTS solution_books;

CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 문제집 하나에 여러 파일(문제집 본문·해설지 등). 파일 단위로 추출 상태 관리.
CREATE TABLE book_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE book_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('개념','팁','문제','해설')),
  number TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  page INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_book_files_book ON book_files(book_id);
CREATE INDEX idx_book_items_book ON book_items(book_id, category);

-- 퀴즈 자동 등록 출처 추적: 문제집에서 온 문제는 book_id+book_number로 중복 방지,
-- src_file_id+src_page로 원본 페이지(도형·그림) 열람
ALTER TABLE questions ADD COLUMN book_id INTEGER;
ALTER TABLE questions ADD COLUMN book_number TEXT;
ALTER TABLE questions ADD COLUMN src_file_id INTEGER;
ALTER TABLE questions ADD COLUMN src_page INTEGER;
