ALTER TABLE materials ADD COLUMN retry_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_chunk_count >= 0);
ALTER TABLE materials ADD COLUMN chunk_total INTEGER NOT NULL DEFAULT 0 CHECK (chunk_total >= 0);

CREATE TABLE material_extraction_chunks (
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  page_from INTEGER NOT NULL CHECK (page_from >= 1),
  page_to INTEGER NOT NULL CHECK (page_to >= page_from),
  content TEXT NOT NULL,
  PRIMARY KEY (material_id, chunk_index)
);
