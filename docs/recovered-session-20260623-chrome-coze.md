# 找回记录：Chrome 插件 MVP 与 Coze Prompt 需求梳理

来源会话：`20260623_163437_37b802`，标题：`在线知识空间架构设计 #4`  
结束原因：`ws_orphan_reap`，不是删除，是 WebSocket 连接失联后被系统回收结束。

## 1. Chrome 插件 MVP 已完成

本地目录：

```text
/Users/dj/knowledge-space-worker/chrome-extension
```

已生成主要文件：

```text
manifest.json
background.js
shared.js
popup.html
popup.js
options.html
options.js
content-selection.js
result.html
result.js
icons/icon16.png
icons/icon48.png
icons/icon128.png
README.md
```

核心能力：

- 点击插件图标收录当前页；
- 读取当前页面标题、URL、选中文本；
- 右键菜单收录选中文本/当前页/链接；
- 调用 Worker `/ingest`；
- 后续继续走 Coze + Notion；
- Token 不写死在代码里，保存在插件设置页；
- 弹窗快速关闭，后台继续处理；
- 完成后通过 Chrome 系统通知提示成功/失败；
- 插件图标角标短暂显示 `✓` 或 `!`；
- 修复过 Chrome notifications 的 SVG/PNG 图标加载问题。

验证记录：

- 曾完成插件 MVP 测试；
- 修过通知图标问题；
- 后续完整测试已达到 `18 pass`。

## 2. Chrome 插件安装方式

Chrome 打开：

```text
chrome://extensions
```

操作：

1. 开启「开发者模式」；
2. 点击「加载已解压的扩展程序」；
3. 选择目录：

```text
/Users/dj/knowledge-space-worker/chrome-extension
```

插件选项配置：

```text
Worker URL = https://knowledge-space-worker.dj-knowledge.workers.dev
INGEST_TOKEN = 当前有效 token
```

## 3. Coze Prompt 需求梳理结论

### 3.1 标签策略

最终方向：

```text
预设标签池 + AI 从中选择 + 少量新标签候选
```

不建议纯 AI 自由生成标签，因为会造成 Notion 里标签膨胀和同义词混乱。

用户偏好：

```text
核心用途：技术知识 + 行业知识
Notion 主视图：按技术主题查看
客户相关知识：归入行业信息，不单独做客户字段
产品线：不进入标签，也不单独建字段
第一版标签池：约 30-60 个
```

字段设计：

```text
Category：固定一级分类
Tags：从预设标签池中选 3-6 个
Entities：工具名、公司名、人名、产品名、客户名等自由提取
suggested_tags：标签池不够用时建议，不直接写入 Tags
```

### 3.2 Entities 定位

`Entities` 用于存具体名词：

```text
公司名
产品名
工具名
人物名
机构名
项目名
技术框架名
国家/地区名
```

区别：

```text
Tags：稳定主题分类，用来看板/筛选
Entities：具体名词，用于检索/聚合/RAG，不污染标签体系
```

Notion 字段建议：

```text
Entities = Rich text
```

不要用 Multi-select，避免实体无限增长污染选项。

### 3.3 Summary 风格

用户偏好：

```text
以技术趋势判断为主
兼顾工作应用启发
弱化纯复述型摘要
短而有判断，不写长文
帮助快速回忆原文大意
细节回源查看
```

建议长度：

```text
普通内容：150-250 字
高价值内容：250-400 字
特别高价值内容：最多 500 字以内
```

Summary 应回答：

```text
这条内容代表什么趋势？
这个趋势成熟了吗？
对技术路线/行业变化/工作应用有什么启发？
以后可以怎么用？
```

### 3.4 Confidence / Limitations

置信度使用中文：

```text
高 / 中 / 低
```

需要保留 limitations / 信息不足提醒，避免对短视频、简介、链接类内容过度脑补。

### 3.5 视频、图片、小红书策略

总体原则：

```text
轻量判断来源平台 + 内容类型 + 信息充分度
→ 使用不同总结策略
→ 控制 token 和耗时
```

不要默认做：

```text
视频转写
全网页正文抓取
多张图片识别
长文全文深度分析
```

视频策略：

```text
默认不转写
优先使用标题、简介、分享文本总结
信息不足时 confidence=低，并写 limitations
```

图片/小红书策略：

```text
小红书/图片类内容可以允许轻量 OCR
但不默认重度 OCR
最多处理用户明确上传/分享的关键图片 1-3 张
只提取文字，不做复杂视觉理解
```

小红书当前阶段先不深入做，原因：

```text
iOS 小红书通常不能稳定直接分享到快捷指令
现实流程是：复制链接/分享到浏览器 → Safari 分享到知识库
先低成本链接收录，后续再增强 OCR/截图能力
```

## 4. 当前建议下一步

1. 先确保 Chrome 插件安装并测试 ChatGPT 页面收录；
2. Coze Prompt 不急着直接改，先把标签池和输出字段最终定稿；
3. 小红书先保持低成本链接收录方案；
4. RAG / Dify 后续再做。
