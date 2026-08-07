-- AI 모의고사 문항을 한 작업으로 묶고, 공식 순서·배점·공유 지문을 보존한다.
ALTER TABLE questions ADD COLUMN mock_exam_job_id INTEGER REFERENCES ai_jobs(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN mock_exam_title TEXT;
ALTER TABLE questions ADD COLUMN exam_order INTEGER CHECK (exam_order IS NULL OR exam_order BETWEEN 1 AND 45);
ALTER TABLE questions ADD COLUMN exam_points REAL CHECK (exam_points IS NULL OR exam_points IN (1.5, 2, 2.5, 3, 4));
ALTER TABLE questions ADD COLUMN exam_section TEXT;
ALTER TABLE questions ADD COLUMN passage_group TEXT;
ALTER TABLE questions ADD COLUMN passage TEXT;

CREATE UNIQUE INDEX idx_questions_mock_exam_order
  ON questions(mock_exam_job_id, exam_order)
  WHERE mock_exam_job_id IS NOT NULL;
