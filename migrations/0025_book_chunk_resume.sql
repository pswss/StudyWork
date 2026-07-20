ALTER TABLE book_files ADD COLUMN retry_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_chunk_count >= 0);
ALTER TABLE book_files ADD COLUMN chunk_total INTEGER NOT NULL DEFAULT 0 CHECK (chunk_total >= 0);
ALTER TABLE book_files ADD COLUMN answer_key_pages TEXT
  CHECK (answer_key_pages IS NULL OR (json_valid(answer_key_pages) AND json_type(answer_key_pages) = 'array'));
ALTER TABLE book_files ADD COLUMN answer_key_scan_complete INTEGER NOT NULL DEFAULT 0
  CHECK (answer_key_scan_complete IN (0, 1));

CREATE TABLE book_extraction_chunks (
  file_id INTEGER NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'array'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (file_id, chunk_index)
);
