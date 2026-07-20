ALTER TABLE materials
ADD COLUMN book_processing INTEGER NOT NULL DEFAULT 0 CHECK (book_processing IN (0, 1));
