-- 配置表：存储用户在配置页面填写的 API Key、提示词等
CREATE TABLE IF NOT EXISTS kb_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
