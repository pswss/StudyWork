CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('uploaded','generated')),
  qtype TEXT NOT NULL CHECK (qtype IN ('mcq','short','ox')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('하','중','상')),
  question TEXT NOT NULL,
  choices TEXT,
  answer TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
