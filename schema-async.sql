-- 异步任务表：/ingest 立即返回任务 ID，后台处理完后写入结果
CREATE TABLE IF NOT EXISTS async_tasks (
  id TEXT PRIMARY KEY,                -- 任务 ID（UUID）
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'processing',   -- processing / done / error
  source_url TEXT,
  title TEXT,
  result_json TEXT,                   -- 完整处理结果 JSON
  error TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_async_status ON async_tasks(status);
CREATE INDEX IF NOT EXISTS idx_async_created ON async_tasks(created_at DESC);
