-- 단권화 기록: 실행할 때마다 새 버전으로 쌓는다 (덮어쓰기 대신)
CREATE TABLE note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_note_versions_subject ON note_versions(subject_id);

-- 기존 노트를 첫 버전으로 승계
INSERT INTO note_versions (subject_id, content, created_at)
SELECT subject_id, content, updated_at FROM notes WHERE content != '';
