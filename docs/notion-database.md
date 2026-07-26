# Notion Database 设置

用户已在 Notion 中创建数据库：`Knowledge Items`。

## 当前字段映射

Worker 当前按以下英文字段名写入：

| Notion 字段名 | 类型 | Worker 含义 |
|---|---|---|
| Title | Title | title |
| Summary | Text/Rich text | summary |
| Key Points | Text/Rich text | key_points |
| Category | Select | category |
| Tags | Multi-select | tags |
| Entities | Text/Rich text | entities |
| Source URL | URL | source_url |
| Source Platform | Select | source_platform |
| Content Type | Select | content_type |
| Captured At | Date | captured_at |
| Published At | Date | published_at |
| Author | Text/Rich text | author |
| Importance | Number | importance |
| Confidence | Select | confidence |
| Basis | Text/Rich text | basis |
| Privacy | Select | privacy |
| Vector Status | Select | vector_status |

字段建议顺序：

```text
Title
Summary
Key Points
Category
Tags
Entities
Source URL
Source Platform
Content Type
Captured At
Published At
Author
Importance
Confidence
Basis
Privacy
Vector Status
```

注意：Notion 页面如果被 Google 翻译，会把英文字段显示成中文；以关闭翻译后的字段为准。

## 下一步：创建 Notion Integration

1. 打开：https://www.notion.so/my-integrations
2. 新建 Integration：`Knowledge Space Worker`
3. 复制 Secret，作为 `NOTION_API_KEY`
4. 回到 `Knowledge Items` 数据库页面
5. 右上角 `...` → `Connections` / `连接` / `Connect to` → 选择 `Knowledge Space Worker`
6. 复制数据库 URL 中的 database id，作为 `NOTION_DATABASE_ID`

如果忘记 Connect，Notion API 会返回 404。
