CREATE TABLE ai_model_settings (
  operation TEXT PRIMARY KEY,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
