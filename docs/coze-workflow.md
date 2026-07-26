# Coze Workflow 设计

## 目标

输入一条分享内容，输出结构化知识条目 JSON。

Worker 会把下面对象传给 Coze：

```json
{
  "id": "ki_xxx",
  "title": "分享标题",
  "source_url": "https://...",
  "canonical_url": "https://...",
  "text": "用户选中文本/分享文本",
  "images": [],
  "file_url": "",
  "source_platform": "知乎/B站/网页/...",
  "capture_device": "ios/chrome/local",
  "privacy": "personal",
  "content_type": "article/video/pdf/...",
  "captured_at": "2026-06-22T...Z"
}
```

## 推荐节点

1. **输入节点**：接收完整 JSON。
2. **平台识别节点**：根据 `source_url/source_platform/content_type` 判断来源。
3. **内容提取节点**：
   - 有 `text`：优先使用 text。
   - 有 `source_url`：尝试抓取页面 title/meta/正文。
   - 视频：优先使用标题、简介，不强制转写。
   - 图片：如果 Coze 可 OCR，则提取 OCR；否则保留图片链接。
4. **LLM 结构化节点**：输出严格 JSON。
5. **结束节点**：返回 JSON 字符串或对象。

## LLM Prompt

```text
你是我的个人知识空间整理助手。请把用户分享的网页/帖子/视频/文档整理成结构化知识条目。

要求：
1. 不要编造不存在的信息。
2. 如果无法获取正文，就基于 title、text、source_url、图片 OCR 或视频简介做保守摘要。
3. 视频内容为了节省 token，优先基于标题和简介总结，不强制转写。
4. 标签要短，最多 8 个。
5. category 只能从以下选项选择：AI、客户、销售、产品、技术、投资、生活、其他。
6. 输出必须是 JSON，不要 Markdown，不要解释。

输入：
{{input}}

输出 JSON schema：
{
  "title": "最终标题",
  "summary": "100-300字摘要",
  "key_points": ["要点1", "要点2", "要点3"],
  "tags": ["标签1", "标签2"],
  "category": "AI|客户|销售|产品|技术|投资|生活|其他",
  "source_platform": "知乎|B站|微信公众号|视频号|小红书|抖音|网页|本地文档|manual",
  "content_type": "article|video|image|pdf|doc|ppt|local_file",
  "author": "作者/UP主，没有则空字符串",
  "published_at": "ISO日期，没有则空字符串",
  "entities": ["公司/人名/产品/地点"],
  "importance": 1到5的数字
}
```

## Worker 对接方式

Worker 调用：

```http
POST {COZE_BASE_URL}/v1/workflow/run
Authorization: Bearer {COZE_API_KEY}
Content-Type: application/json
```

Body：

```json
{
  "workflow_id": "你的 COZE_WORKFLOW_ID",
  "parameters": {
    "id": "ki_xxx",
    "title": "...",
    "source_url": "...",
    "text": "..."
  }
}
```

## 注意

- 国内扣子一般配置：`COZE_BASE_URL=https://api.coze.cn`
- 海外 Coze 一般配置：`COZE_BASE_URL=https://api.coze.com`
- 如果接口格式与你账号版本不同，需要根据 Coze 实际 API 文档微调 `src/worker.js` 的 `enrichWithCoze()`。
