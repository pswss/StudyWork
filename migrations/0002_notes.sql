CREATE TABLE notes (
  subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
