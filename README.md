# 📚 知识空间 Worker

一个自动化内容收录工具：发送一条链接 → 自动提取正文 → AI 生成摘要/分类/标签 → 写入 Notion 知识库 → 推送通知到手机。

## 工作流程

```
用户发送链接 → Cloudflare Worker → 内容提取 → AI 分析 → 写入 Notion → 推送通知
```

- **电脑端**：Chrome 插件一键收录当前页面/选中文本，完成后弹 macOS 系统通知
- **手机端**：iOS 快捷指令，复制链接后从分享菜单收录，完成后 Bark 推送通知

## 部署指南

### 前置条件（只需做一次）

1. 安装 [Node.js](https://nodejs.org/) 18 以上版本（终端输入 `node -v` 确认）
2. 安装 Cloudflare 命令行工具：`npm i -g wrangler`
3. 登录 Cloudflare：`npx wrangler login`（会弹出浏览器授权）
4. **Windows 用户**：请用 [Git for Windows](https://git-scm.com/download/win) 自带的 **Git Bash** 运行下面的命令，**不要用 PowerShell**（`&&`、`bash` 等在 PowerShell 里会报错）。装好后开始菜单打开 Git Bash（窗口标题 `MINGW64`，提示符 `$`）。macOS / Linux 用户用系统自带终端即可。

### 🚀 一键部署

分两步：**先获取代码，再部署**。脚本会自动完成建库、写配置、建队列、建表、生成令牌，全程无需手动操作。

**第 1 步 · 获取代码**

把项目克隆到本地（也可直接下载 ZIP 解压）：

```bash
git clone https://github.com/dongjun-dj/knowledge-space-worker.git
```

这会创建一个 `knowledge-space-worker` 文件夹。

**第 2 步 · 进入目录并一键部署**

进入项目目录并执行脚本：

```bash
cd knowledge-space-worker && bash scripts/setup.sh
```

脚本会自动建库、写配置、建队列、建表、部署、生成令牌。跑完会打印部署完成信息，**务必保存其中的访问地址和访问令牌**：

```
✅ 部署完成！
  访问地址:  https://xxx.workers.dev/admin?token=<你的令牌>
  访问令牌:  <你的令牌>
```

> ⚠️ **请妥善保存访问令牌**，后续登录配置页面、配置手机快捷指令、配置浏览器插件都要用。丢了只能重新部署生成。
>
> 💡 只需部署一次。以后想更新代码，进入目录执行 `git pull` 再 `bash scripts/setup.sh` 即可。脚本是幂等的，可重复运行。

### 🎯 打开配置页面

部署成功后，在浏览器打开上面打印的访问地址，按页面步骤完成各服务的 Key 配置即可：

```
https://<你的Worker域名>.workers.dev/admin?token=<上面的访问令牌>
```

---

## 配置说明

打开配置页面后，按顺序完成 5 步配置：

| 步骤 | 配置项 | 说明 |
|------|--------|------|
| 1 | 内容提取 | TikHub（知乎/小红书/B站/公众号）、Firecrawl（通用兜底）、火山引擎 OCR（小红书图片） |
| 2 | AI 分析 | 支持 OpenAI 兼容接口的大模型（火山引擎豆包/DeepSeek/OpenAI 等） |
| 3 | 写入知识库 | Notion 数据库（需提前创建集成和数据库） |
| 4 | 推送通知 | Bark 推送（仅手机端需要，电脑端 Chrome 插件自带通知） |
| 5 | 安装客户端 | Chrome 插件 + iOS 快捷指令 |

### Notion 数据库准备

在配置页面的第 3 步之前，需要先在 Notion 做好准备：

1. 打开 [notion.so/profile/integrations](https://www.notion.so/profile/integrations)，创建一个内部集成，获取 Token
2. 在 Notion 新建一个数据库（表格视图），添加以下属性（列）：

   | 属性名 | 类型 |
   |--------|------|
   | Title | 标题 |
   | Summary | 文本 |
   | Key Points | 文本 |
   | Category | 单选 |
   | Tags | 多选 |
   | Source URL | URL |
   | Source Platform | 单选 |
   | Content Type | 单选 |
   | Author | 文本 |
   | Importance | 数字 |
   | Confidence | 单选 |
   | Entities | 文本 |
   | Basis | 文本 |
   | Privacy | 单选 |
   | Captured At | 日期 |
   | Published At | 日期 |

3. 把数据库分享给刚才创建的集成（数据库右上角 `···` → Connections → 添加集成）
4. 获取数据库 ID：看数据库的 URL，中间那串 32 位字符就是

### iOS 快捷指令配置

1. 打开「快捷指令」App，新建一个快捷指令
2. 添加操作「获取剪贴板」
3. 添加操作「URL」，填入 `https://<你的Worker域名>/ingest`
4. 添加操作「获取 URL 内容」，方法改为 **POST**
5. 添加两个请求头：
   - `Content-Type: application/json`
   - `Authorization: Bearer <你的令牌>`
6. 请求体改为 JSON，填入：`{"url":"[[剪贴板]]"}`
7. 保存快捷指令，可添加到分享菜单

### Chrome 插件配置

1. 打开 `chrome://extensions/`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选中项目的 `chrome-extension/` 目录
3. 点击插件图标 → 设置 → 填入 Worker URL 和 Token
4. 在 macOS 系统设置 → 通知 → Google Chrome 中允许通知（否则收录完成后不会弹通知）

## 项目结构

```
knowledge-space-worker/
├── scripts/
│   └── setup.sh           # 一键部署脚本（bash scripts/setup.sh）
├── src/
│   ├── worker.js          # Worker 主代码
│   └── admin.html.js      # 配置页面
├── chrome-extension/       # Chrome 插件
│   ├── manifest.json
│   ├── popup.html
│   └── popup.js
├── schema.sql             # D1 日志表结构
├── schema-async.sql       # D1 异步任务表结构
└── wrangler.toml          # Cloudflare 配置
```

## 技术栈

- **Cloudflare Workers** — Serverless 运行时
- **Cloudflare D1** — SQLite 数据库（日志和配置存储）
- **Cloudflare Queues** — 异步任务队列
- **TikHub / Firecrawl** — 内容提取
- **火山引擎 OCR** — 小红书图片文字识别
- **OpenAI 兼容 LLM** — AI 摘要/分类/标签
- **Notion API** — 知识库写入
- **Bark** — iOS 推送通知

## License

MIT
