CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'error')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_jobs_subject_created
  ON ai_jobs(subject_id, created_at DESC);

-- 시험과 TODO를 한 batch 트랜잭션에서 저장할 때 방금 생성한 시험을 안정적으로 참조한다.
ALTER TABLE exams ADD COLUMN ai_job_id INTEGER REFERENCES ai_jobs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_exams_ai_job_id ON exams(ai_job_id) WHERE ai_job_id IS NOT NULL;
