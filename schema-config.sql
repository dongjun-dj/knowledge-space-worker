-- 配置表：存储用户在配置页面填写的 API Key、提示词等
CREATE TABLE IF NOT EXISTS kb_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- 待处理队列表：收录任务排队等待处理
CREATE TABLE IF NOT EXISTS pending_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  source_url TEXT,
  title TEXT,
  notion_page_id TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_queue(status);
