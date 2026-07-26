-- KB 监控日志表
CREATE TABLE IF NOT EXISTS ingest_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,           -- ISO 时间戳
  request_id TEXT NOT NULL UNIQUE,    -- 每次 /ingest 唯一 ID
  source_url TEXT,
  title TEXT,
  source_platform TEXT,
  capture_device TEXT,                -- ios / chrome-extension / cli
  status TEXT NOT NULL,               -- ok / partial / error
  raw_payload JSON,                   -- 收到的原始 payload
  jina_status TEXT,                   -- ok_200_len17685_9132ms / fail / skip
  jina_text_length INTEGER,           -- Jina 抓到的正文长度
  coze_input JSON,                    -- 送给 Coze 的完整字段
  coze_output JSON,                   -- Coze 返回的原始 JSON
  coze_error TEXT,                    -- Coze 报错
  notion_page_id TEXT,
  notion_page_url TEXT,
  notion_status TEXT,                 -- ok / error / skip
  notion_error TEXT,
  duration_ms INTEGER,
  error TEXT                          -- 全流程报错
);

CREATE INDEX IF NOT EXISTS idx_created_at ON ingest_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_status ON ingest_logs (status);
CREATE INDEX IF NOT EXISTS idx_source_platform ON ingest_logs (source_platform);
