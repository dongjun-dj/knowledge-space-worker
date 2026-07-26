# Dify 设置

## 1. 创建知识库

在 Dify 中创建 Dataset / Knowledge Base，例如：`个人知识空间`。

建议选择高质量索引。

## 2. 获取 DIFY_DATASET_ID

进入知识库页面，URL 或 API 文档中可以看到 dataset id。

## 3. 获取 DIFY_API_KEY

在 Dify 里创建 API Key。

注意：

- 如果用的是 Dify Cloud，base url 通常是 `https://api.dify.ai`。
- 如果是自建 Dify，配置你自己的 `DIFY_BASE_URL`。

## 4. Worker 写入方式

Worker 会调用：

```http
POST /v1/datasets/{DIFY_DATASET_ID}/document/create_by_text
```

写入内容包含：

- 标题
- 摘要
- 分类
- 标签
- 来源平台
- 原链接
- Notion 页面链接
- 关键要点
- 原始文本

## 5. Worker 检索方式

Worker 会调用：

```http
POST /v1/datasets/{DIFY_DATASET_ID}/retrieve
```

然后包装为统一返回：

```json
{
  "ok": true,
  "query": "AI Agent",
  "results": [
    {
      "id": "docid",
      "title": "标题",
      "summary": "摘要",
      "snippet": "命中片段",
      "tags": ["AI"],
      "source_url": "https://...",
      "notion_page_url": "https://...",
      "score": 0.88
    }
  ]
}
```

## 6. MVP 取舍

当前 Worker 已经能写入 Dify 和检索 Dify。

但 Dify 的 metadata 细节在不同版本可能有差异。如果你希望检索结果里稳定返回 Notion URL、标签、来源链接，后续可以增强为：

- Dify 只存向量和片段；
- Cloudflare D1 / KV 额外存 `id -> metadata`；
- `/search` 检索 Dify 后再回查 metadata。

MVP 阶段先不加数据库，避免复杂度过高。
