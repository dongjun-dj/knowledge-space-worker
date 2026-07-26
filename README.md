# Knowledge Space Worker

这是一套 `Notion + Coze + Dify + Cloudflare Worker` 的个人在线知识空间入口服务。

## 已实现能力

- `GET /health`：健康检查。
- `POST /ingest`：接收手机/电脑分享内容，调用 Coze 做结构化摘要，写入 Notion，并同步到 Dify 知识库。
- `GET /search?q=...&top_k=5`：调用 Dify 知识库检索，返回稳定 JSON，供 Hermes/Codex/本地脚本调用。
- 未配置 Coze 时，会自动 fallback：根据标题/文本生成基础摘要、分类和标签，保证链路不中断。

## 目录

```text
knowledge-space-worker/
  src/worker.js                 # Cloudflare Worker 主程序
  test/worker.test.js           # 自动化测试
  wrangler.toml                 # Cloudflare Worker 配置
  package.json
  .env.example                  # 环境变量示例
  docs/
    notion-database.md          # Notion 数据库字段
    coze-workflow.md            # Coze 工作流设计
    dify-setup.md               # Dify 设置
    share-entrypoints.md        # 手机/电脑一键分享入口
  scripts/
    kb_search.py                # 本地 Hermes/Codex 可调用检索脚本
```

## 本地测试

```bash
cd /Users/dj/knowledge-space-worker
source ~/.nvm/nvm.sh
nvm use 20
npm install
npm test
```

当前测试结果：`7 passed`。

## 部署前需要准备

### 1. Cloudflare

- 登录 Cloudflare。
- 安装 Wrangler：本项目已通过 `npx wrangler` 使用。
- 登录：

```bash
cd /Users/dj/knowledge-space-worker
source ~/.nvm/nvm.sh
nvm use 20
npx wrangler login
```

### 2. Notion

你需要：

- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`

Notion 数据库字段见：`docs/notion-database.md`。

### 3. Coze

你需要：

- `COZE_API_KEY`
- `COZE_WORKFLOW_ID`
- 如果使用国内扣子：配置 `COZE_BASE_URL=https://api.coze.cn`
- 如果使用海外 Coze：通常为 `https://api.coze.com`

工作流输出 schema 见：`docs/coze-workflow.md`。

### 4. Dify

你需要：

- `DIFY_API_KEY`
- `DIFY_DATASET_ID`
- 如果是自建 Dify：配置 `DIFY_BASE_URL`

Dify 设置见：`docs/dify-setup.md`。

## 设置 Cloudflare Worker Secrets

```bash
cd /Users/dj/knowledge-space-worker
source ~/.nvm/nvm.sh
nvm use 20

npx wrangler secret put INGEST_TOKEN
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put NOTION_DATABASE_ID
npx wrangler secret put COZE_API_KEY
npx wrangler secret put COZE_WORKFLOW_ID
npx wrangler secret put COZE_BASE_URL
npx wrangler secret put DIFY_API_KEY
npx wrangler secret put DIFY_DATASET_ID
npx wrangler secret put DIFY_BASE_URL
```

说明：

- `INGEST_TOKEN` 是你自己设置的一串密钥，手机/Chrome/Hermes 调用接口时都要带上。
- 如果暂时不用 Coze，可以不设置 Coze 变量，系统会 fallback。
- 如果暂时不用 Dify，可以不设置 Dify 变量，但 `/search` 会返回空结果。

## 部署

```bash
cd /Users/dj/knowledge-space-worker
source ~/.nvm/nvm.sh
nvm use 20
npx wrangler deploy
```

部署成功后会得到类似：

```text
https://knowledge-space-worker.<your-subdomain>.workers.dev
```

## 验证接口

### 健康检查

```bash
curl "https://你的-worker-url/health"
```

### 收录测试

```bash
curl -X POST "https://你的-worker-url/ingest" \
  -H "Authorization: Bearer 你的_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://example.com/article/1",
    "title": "AI Agent 个人知识库测试",
    "text": "这是一条测试内容，讲如何用 RAG 和 Agent 构建个人知识库。",
    "source_platform": "网页",
    "capture_device": "curl",
    "privacy": "personal"
  }'
```

### 检索测试

```bash
curl "https://你的-worker-url/search?q=AI%20Agent&top_k=5" \
  -H "Authorization: Bearer 你的_INGEST_TOKEN"
```

## 给 Hermes/Codex 使用

配置本地环境变量：

```bash
export KB_API_BASE="https://你的-worker-url"
export KB_API_TOKEN="你的_INGEST_TOKEN"
```

执行：

```bash
python3 /Users/dj/knowledge-space-worker/scripts/kb_search.py "AI Agent 知识库"
```

返回 Markdown 格式检索结果，适合直接喂给 Hermes/Codex。
