-- 待收录队列：手机端抓不到内容时入队，桌面 Chrome 定时消费
CREATE TABLE IF NOT EXISTS pending_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT,
  reason TEXT NOT NULL,            -- blocked / jina_error / no_content
  capture_device TEXT,
  raw_payload TEXT,                -- JSON: 原始 Chrome/iOS 送来的字段
  status TEXT DEFAULT 'pending',   -- pending / consumed / abandoned
  consumed_at TEXT,
  notion_page_id TEXT              -- 消费后写入的 Notion 页 id
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_queue(status);
CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_queue(created_at DESC);
