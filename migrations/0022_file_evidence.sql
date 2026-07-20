ALTER TABLE materials ADD COLUMN error TEXT;
ALTER TABLE materials ADD COLUMN content_hash TEXT;
ALTER TABLE materials ADD COLUMN original_filename TEXT;
ALTER TABLE materials ADD COLUMN page_count INTEGER;
ALTER TABLE materials ADD COLUMN extraction_method TEXT;
ALTER TABLE materials ADD COLUMN ocr_used INTEGER;
ALTER TABLE materials ADD COLUMN integrity_warning TEXT;
ALTER TABLE materials ADD COLUMN integrity_checked_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS materials_subject_content_hash
ON materials(subject_id, content_hash)
WHERE content_hash IS NOT NULL;

ALTER TABLE book_files ADD COLUMN content_hash TEXT;
ALTER TABLE book_files ADD COLUMN page_count INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS book_files_book_content_hash
ON book_files(book_id, content_hash)
WHERE content_hash IS NOT NULL;
