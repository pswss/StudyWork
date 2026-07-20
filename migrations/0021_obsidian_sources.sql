ALTER TABLE materials ADD COLUMN source_type TEXT;
ALTER TABLE materials ADD COLUMN source_path TEXT;
ALTER TABLE materials ADD COLUMN source_hash TEXT;
ALTER TABLE materials ADD COLUMN source_modified_at TEXT;

CREATE UNIQUE INDEX idx_materials_obsidian_source
ON materials(subject_id, source_type, source_path)
WHERE source_type = 'obsidian' AND source_path IS NOT NULL;
