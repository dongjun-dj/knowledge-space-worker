# 个人在线知识空间需求规格 V1

更新时间：2026-06-24

本文档用于沉淀当前已讨论定稿的个人在线知识空间需求，方便后续追溯、修改 Coze Prompt、调整 Notion 字段、更新 Cloudflare Worker 映射，以及后续接入 Dify/RAG。

---

## 1. 总体目标

构建一套在线个人知识空间，用于收录、整理和检索来自网页、社交平台、视频平台、ChatGPT 对话、本地文档等来源的信息。

核心目标：

```text
快速收录
自动摘要
自动分类
自动打标签
保留原链接
支持手机查看
后续支持 RAG/API 检索
```

整体原则：

```text
低时延
低 token 消耗
稳定优先
不默认做重处理
不依赖本机长期运行
线上全流程运行
```

---

## 2. 当前架构

当前选定架构：

```text
Notion + Coze + Dify + Cloudflare Worker
```

各组件分工：

| 组件 | 作用 |
|---|---|
| Cloudflare Worker | 统一 API 网关，接收收录请求，调用 Coze，写入 Notion，后续对接 Dify |
| Notion | 在线知识空间 UI 和结构化数据库 |
| Coze | 摘要、分类、标签、重要性、置信度、依据生成 |
| Dify | 后续 RAG 检索，当前暂缓 |
| Chrome / iPhone | 内容收录入口 |
| Hermes / Codex | 后续通过 API 调用知识库检索 |

当前阶段：

```text
先完成 Notion + Worker + Coze 的结构化收录；RAG 后续再做。
```

---

## 3. 已跑通链路

已验证成功：

```text
Chrome Console → Worker → Notion ✅
Chrome 书签收录 → Worker → Notion ✅
iPhone 快捷指令 → Worker → Notion ✅
Safari 分享 → iPhone 快捷指令 → Worker → Notion ✅
Coze Workflow → Worker → Notion ✅
```

Coze 接入验证返回关键字段：

```text
coze_status = ok
notion_status = created
```

---

## 4. Notion 字段顺序

最终字段顺序：

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

字段分组逻辑：

### 4.1 内容字段

```text
Title
Summary
Key Points
```

用于快速了解：

```text
这是什么内容
讲了什么
核心要点是什么
```

### 4.2 分类、对象与回源字段

```text
Category
Tags
Entities
Source URL
```

用于判断：

```text
属于哪个大类
有哪些主题标签
涉及哪些具体对象
原文链接是什么
```

### 4.3 来源与时间字段

```text
Source Platform
Content Type
Captured At
Published At
Author
```

用于查看：

```text
来自哪里
是什么内容形态
什么时候收录
什么时候发布
谁发布的
```

### 4.4 价值、可信度和系统字段

```text
Importance
Confidence
Basis
Privacy
Vector Status
```

用于判断：

```text
值不值得回看
摘要靠不靠谱
生成依据和不足
隐私级别
RAG 入库状态
```

---

## 5. 字段中英文对照与类型

| 英文字段 | 中文含义 | 建议类型 | 用途 |
|---|---|---|---|
| Title | 标题 | Title | 内容标题 |
| Summary | 摘要 | Rich text | 1-2 段自然语言摘要 |
| Key Points | 关键要点 | Rich text | 最多 3 条核心要点 |
| Category | 一级分类 | Select | 固定一级分类 |
| Tags | 标签 | Multi-select | 固定主题标签池 |
| Entities | 具体对象 | Rich text | 公司、客户、工具、产品、模型、框架、人物等 |
| Source URL | 原文链接 | URL | 回源查看原文 |
| Source Platform | 来源平台 | Select | 网页、知乎、B站、小红书、ChatGPT 等 |
| Content Type | 内容类型 | Select | article、video、image、chat、pdf、doc 等 |
| Captured At | 收录时间 | Date | 内容进入知识库的时间 |
| Published At | 发布时间 | Date | 原内容发布时间，能获取则填 |
| Author | 作者/账号 | Rich text | 作者、发布账号、机构或来源名称 |
| Importance | 重要性 | Number | 1-5 评分 |
| Confidence | 置信度 | Select | 高 / 中 / 低 |
| Basis | 依据与不足 | Rich text | 生成依据、信息不足、未覆盖范围 |
| Privacy | 隐私级别 | Select | personal、work、sensitive 等 |
| Vector Status | RAG 入库状态 | Select | skipped、pending、indexed、failed 等 |

字段名保持英文，字段内容和选项可以中文。

---

## 6. 新增字段

新增字段：

```text
Key Points
Entities
Importance
Confidence
Basis
```

不新增：

```text
Processing Mode
```

原因：当前不进入复杂多处理模式阶段，避免增加维护成本。

---

## 7. Category 一级分类

最终 Category：

```text
AI技术
云计算与基础设施
软件工程
数据与安全
其他技术
行业研究
商业与管理
效率工具
个人成长
宏观与社会
其他
```

### 7.1 技术知识空间

Notion 技术知识空间视图包含：

```text
AI技术
云计算与基础设施
软件工程
数据与安全
其他技术
```

### 7.2 综合知识空间

Notion 综合知识空间视图包含：

```text
行业研究
商业与管理
效率工具
个人成长
宏观与社会
其他
```

底层仍然是一张数据库：

```text
Knowledge Items
```

通过视图区分技术知识空间和综合知识空间，不拆成两个数据库。

---

## 8. Category 分类规则

### 8.1 AI 优先规则

当内容同时涉及多个分类时，按主线判断。

规则：

```text
AI 是主线 → Category = AI技术
AI 只是辅助 → Category = 实际主领域
其他相关方向 → 用 Tags 补充
具体工具/平台/方法名 → 用 Entities
```

示例：

```text
AI Coding + TDD
```

应为：

```text
Category = AI技术
Tags = AI Coding, 开发范式, 工程效率
Entities = TDD
```

### 8.2 其他技术规则

`其他技术` 用于明显属于技术类，但不适合归入以下分类的内容：

```text
AI技术
云计算与基础设施
软件工程
数据与安全
```

例如：

```text
大数据
数据库内核
编译原理
嵌入式
物联网
通信技术
硬件工程
算法基础
数学建模
测试工程
机器人
区块链技术
```

### 8.3 其他规则

`其他` 用于非技术类内容，但又不适合归入：

```text
行业研究
商业与管理
效率工具
个人成长
宏观与社会
```

注意：不是“非知识类”才归为其他。所有收录信息都可以作为知识；`其他` 是非技术类综合兜底分类。

---

## 9. Tags 标签池

Tags 作为主题标签，第一版固定如下。

```text
大模型
AI Agent
RAG
企业知识库
AI工作流
AI Coding
AI Infra
模型训练
模型推理
多模态
Prompt工程
模型评测
AI应用落地
AI安全治理
私有化部署

云计算
云原生
虚拟化
容器
分布式存储
网络架构
高可用
性能优化

软件架构
API集成
自动化脚本
DevOps
CI/CD
开发范式
工程效率

数据治理
数据分析
数据库
大数据
数据隐私
网络安全
身份权限

行业趋势
企业数字化
制造业
智能制造
供应链
港口物流
汽车产业
出海全球化
信创

商业模式
产品策略
客户需求
解决方案
销售方法
竞品分析
项目管理
ROI分析

个人知识管理
办公自动化
工作流自动化
信息检索
写作表达
学习方法
思维模型
职业发展

宏观经济
国际局势
科技政策
产业政策
资本市场
历史
```

---

## 10. Tags / Entities 规则

### 10.1 Tags 放主题

Tags 表示主题、领域、方法类别。

例如：

```text
AI Coding
开发范式
CI/CD
企业知识库
制造业
销售方法
历史
```

### 10.2 Entities 放具体对象

Entities 表示具体对象、公司、客户、产品、工具、模型、框架、人物、具体方法名。

例如：

```text
Harness
TDD
DDD
Kubernetes
OpenAI
DeepSeek
Coze
Dify
Notion
富士康
比亚迪
招商局
```

### 10.3 边界示例

```text
开发范式 → Tags
TDD / DDD / BDD → Entities

AI Coding → Tags
Cursor / Codex / Claude Code / GitHub Copilot → Entities

CI/CD → Tags
Harness / Jenkins / GitLab CI / Argo CD → Entities
```

### 10.4 标签选择规则

Coze 每条内容选择：

```text
3-6 个 Tags
```

规则：

```text
优先从固定标签池选择
不随意发明新 Tags
来源平台不进 Tags
内容类型不进 Tags
公司名、客户名、工具名、产品名、人名不进 Tags
这些具体对象放入 Entities
```

---

## 11. Importance 评分规则

### 11.1 核心原则

```text
默认从 3 分开始判断
工作/客户/产品可用内容倾向加分
低置信度但主题有价值，允许高 Importance
5 分严格控制
```

### 11.2 评分定义

```text
1 = 普通留档，无明显复用价值
2 = 轻度参考，有一点价值但不值得专门回看
3 = 值得收藏，有明确知识点，未来可能用到
4 = 值得二次阅读/整理，可用于工作、学习、客户交流、材料输出
5 = 高价值长期参考，可沉淀为方法论、判断框架、客户方案或长期参考
```

### 11.3 加分方向

以下内容可适当加分：

```text
AI Agent
RAG
企业知识库
AI 办公自动化
私有化大模型
AI Infra
云计算
制造业数字化
港口物流
供应链
招商局
富士康
比亚迪
影石
客户交流素材
产品方案参考
PPT/BP/月报/日报可用内容
销售话术
方法论沉淀
```

### 11.4 Confidence 与 Importance 独立

低置信度不等于低重要性。

例如：

```text
Importance = 4
Confidence = 低
```

表示：

```text
主题重要，但当前依据不足，值得后续补充处理。
```

---

## 12. Summary 规则

Summary 目标：

```text
短而有判断，帮助快速回忆内容，不重写原文。
```

规则：

```text
不固定小标题
自然语言 1-2 段
重点是快速回忆内容
覆盖：讲了什么、核心判断、对我有什么用
普通内容约 120-220 字
高价值内容约 220-350 字
最高不超过 500 字
不常规写信息不足
```

信息不足主要放：

```text
Basis
Confidence
```

只有当来源极薄时，Summary 可自然带一句：

```text
当前更适合作为线索收藏，需回源确认。
```

但不强制。

---

## 13. Key Points 规则

Key Points 目标：

```text
结构化快速扫核心事实、观点、方法或结论。
```

规则：

```text
最多 3 条
每条一句话
用编号列表
不和 Summary 机械重复
短内容可以少于 3 条，不强行凑满
```

格式：

```text
1. ...
2. ...
3. ...
```

---

## 14. Basis / Confidence 规则

### 14.1 Basis

Basis 说明：

```text
生成依据
信息不足
未覆盖范围
```

示例：

```text
基于小红书分享链接和截图 OCR 文本生成，可能未覆盖完整多图笔记和评论区。
```

```text
基于视频标题、简介和分享文案生成，未获取完整字幕或口播内容。
```

```text
基于选中的 ChatGPT 对话片段生成，未覆盖完整会话上下文。
```

### 14.2 Confidence

固定取值：

```text
高
中
低
```

判断规则：

```text
高 = 正文/选中文本/文档文本充分，判断依据清楚
中 = 信息基本够，但缺少部分上下文或只覆盖片段
低 = 只有标题、链接、简介、分享文案，或 OCR/文本信息很少
```

---

## 15. 平台/内容类型处理策略

### 15.1 总原则

```text
默认轻量处理
不做重抓取
不做视频默认转写
不做复杂视觉理解
有 OCR 文本就用
没有 OCR 就不假装看过图片
信息不足写入 Basis 和 Confidence
```

默认使用已经拿到的信息：

```text
标题
URL
页面标题
分享文案
选中文本
用户备注
OCR 文本，如果已提供
```

不默认做：

```text
全文深度爬取
评论区抓取
视频转写
视频下载
多图视觉分析
自动破解平台内容
```

### 15.2 普通网页 / 博客 / 新闻 / 知乎 / 公众号

默认输入：

```text
标题 + URL + 选中文本/复制文本 + 页面描述
```

规则：

```text
选中文本充分 → Confidence 中/高
只有标题/链接 → Confidence 低
```

### 15.3 ChatGPT / Claude / 豆包等对话

默认输入：

```text
选中的对话内容 + 页面标题 + URL
```

规则：

```text
总结这段对话解决了什么、形成了什么结论、有什么可复用方法
不要写成“这篇文章认为”
```

### 15.4 B站 / 抖音 / 视频号 / 小红书视频

默认输入：

```text
标题 + 简介 + 分享文案 + URL + 用户备注
```

规则：

```text
不默认转写
无字幕时 Confidence 低/中
不能写“视频详细讲解了”
要用“从标题和简介看，可能关注...”
```

### 15.5 小红书图文 / 图片笔记 / 截图 / 长图

默认规则：

```text
有 OCR → 用 OCR
无 OCR → 只基于链接/标题/分享文案，标明图片正文未获取
```

置信度：

```text
OCR 充分 → Confidence 中
OCR 很少或无 OCR → Confidence 低
```

### 15.6 本地文档

默认输入：

```text
文件名 + 已提取文本 + 用户备注
```

规则：

```text
全文充分 → Confidence 高
片段文本 → Confidence 中
只有文件名 → Confidence 低
```

---

## 16. 后续 Notion 视图建议

### 16.1 技术知识空间

筛选：

```text
Category = AI技术 / 云计算与基础设施 / 软件工程 / 数据与安全 / 其他技术
```

### 16.2 综合知识空间

筛选：

```text
Category = 行业研究 / 商业与管理 / 效率工具 / 个人成长 / 宏观与社会 / 其他
```

### 16.3 高价值待增强

筛选：

```text
Importance >= 4
Confidence != 高
```

用途：

```text
后续补 OCR、全文、字幕、文档解析
```

---

## 17. Coze 输出 JSON 建议

后续 Coze Workflow 建议输出字段：

```json
{
  "title": "...",
  "summary": "...",
  "key_points": "1. ...\n2. ...\n3. ...",
  "category": "AI技术",
  "tags": ["AI Coding", "开发范式", "工程效率"],
  "entities": "TDD, Cursor, Claude Code",
  "source_platform": "网页",
  "content_type": "article",
  "author": "...",
  "published_at": "",
  "importance": 4,
  "confidence": "中",
  "basis": "基于网页标题和选中文本生成，未获取完整评论区。"
}
```

注意：

```text
Coze JSON 变量名用英文
Notion 字段名用英文
字段内容用中文
```

---

## 18. 后续实施顺序

建议实施顺序：

```text
1. Notion 新增字段并调整字段顺序
2. Worker 增加字段映射
3. Coze Prompt 更新为 V1 规则
4. 测试网页收录
5. 测试 ChatGPT / AI Coding 类内容
6. 后续再做小红书截图 OCR、剪贴板链接收录、本地文档处理
```

---

## 19. 暂缓事项

当前暂缓：

```text
Dify / RAG 接入
视频自动转写
复杂 OCR / 多图视觉分析
自动抓取小红书完整内容
本地文档批量导入
Chrome Extension 深度开发
```

后续根据使用情况逐步增强。
