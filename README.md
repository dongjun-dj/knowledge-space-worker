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

> 下面的操作**全程在同一个终端里完成**，别中途换终端（登录凭证是全局的，换了也能认出，但统一用一个最省事）。

1. **Windows 用户先准备终端**：安装 [Git for Windows](https://git-scm.com/download/win)（自带 Git Bash），然后从开始菜单打开 **Git Bash** 运行下面的所有命令，**不要用 PowerShell/CMD**。macOS / Linux 用户直接用系统自带终端即可。
2. 安装 [Node.js](https://nodejs.org/) 18 以上版本（终端输入 `node -v` 确认）
3. 安装 Cloudflare 命令行工具：`npm i -g wrangler`
4. **登录 Cloudflare（部署前必须做一次）**：在终端执行 `npx wrangler login`，**会弹出浏览器窗口**让你登录 Cloudflare 并点击授权按钮。授权完成后回到终端，看到 "Successfully logged in" 之类的提示就说明登录成功了。这一步不做，后面的部署会失败。
5. **确认已注册 workers.dev 子域名（一个账号只需注册一次）**：登录 [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages，页面右侧或设置里能看到你的子域名（形如 `<名字>.workers.dev`）。如果还没有，按页面提示注册一个。没有子域名会导致部署失败。

### 🚀 一键部署

分两步：**先获取代码，再部署**。脚本会自动完成建库、写配置、建队列、建表、生成令牌，全程无需手动操作。

**第 1 步 · 获取代码**

任选一种方式：

**方式 A · 下载 ZIP（国内网络更稳，推荐）**

在 [GitHub 项目页](https://github.com/dongjun-dj/knowledge-space-worker) 点绿色的 **Code → Download ZIP**，下载后解压。解压会得到一个 `knowledge-space-worker-main` 文件夹。

**方式 B · git clone（需能稳定直连 GitHub）**

```bash
git clone https://github.com/dongjun-dj/knowledge-space-worker.git
```

这会创建一个 `knowledge-space-worker` 文件夹。

> 💡 两种方式得到的文件夹名**不一样**（ZIP 是 `-main`，clone 没有）。以你上面解压/克隆出来的那个文件夹为准。

**第 2 步 · 进入项目目录**

进入你上面解压/克隆出来的那个文件夹。注意：**用 ZIP 下载的，目录名带 `-main`；用 git clone 的，目录名没有 `-main`**。看你实际是哪个，二选一执行：

```bash
# 如果是 ZIP 下载解压的文件夹：
cd knowledge-space-worker-main

# 如果用的是 git clone（上面方式 B）：
cd knowledge-space-worker
```

（上面两条只执行跟你相符的那一条，不要两条都跑。）

**第 3 步 · 一键部署**

在项目目录里执行脚本：

```bash
bash scripts/setup.sh
```

脚本会自动建库、写配置、建队列、建表、部署、生成令牌。跑完会打印部署完成信息，**务必保存其中的 Worker URL 和 INGEST_TOKEN**：

```
✅ 已完成部署！

  Worker URL: https://xxx.workers.dev
  INGEST_TOKEN: <你的 INGEST_TOKEN>

  请访问: https://xxx.workers.dev/admin?token=<你的 INGEST_TOKEN>  完成后续配置
```

> ⚠️ **请妥善保存 INGEST_TOKEN**，后续登录配置页面、配置手机快捷指令、配置浏览器插件都要用。丢了只能重新部署生成。
>
> 💡 只需部署一次。以后想更新代码，进入目录执行 `git pull` 再 `bash scripts/setup.sh` 即可。脚本是幂等的，可重复运行。

### 🎯 打开配置页面

部署成功后，在浏览器打开上面打印的"请访问"地址，按页面步骤完成各服务的 Key 配置即可：

```
https://<你的Worker域名>.workers.dev/admin?token=<上面的 INGEST_TOKEN>
```

---

## 配置说明

打开配置页面后，按顺序完成 5 步配置：

| 步骤 | 配置项 | 说明 |
|------|--------|------|
| 1 | 内容提取 | TikHub（知乎/小红书/B站/公众号）、Firecrawl（通用兜底）、火山引擎 OCR（小红书图片） |
| 2 | AI 分析 | 支持 OpenAI 兼容接口的大模型（火山引擎豆包/DeepSeek/OpenAI 等） |
| 3 | 写入知识库 | Notion 数据库（需提前创建集成和数据库） |
| 4 | 安装客户端 | Chrome 插件 + iOS 快捷指令 |
| 5 | 推送通知 | Bark 推送（仅手机端需要，电脑端 Chrome 插件自带通知） |

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
   | Entities | 文本 |
   | Source URL | URL |
   | Source Platform | 单选 |
   | Content Type | 单选 |
   | Author | 文本 |
   | Captured At | 日期 |
   | Published At | 日期 |

3. 把数据库分享给刚才创建的集成（数据库页面右上角 `···` → 集成 → 搜索集成名称 → 添加到页面）
4. 获取数据库 ID：看数据库的 URL，中间那串 32 位字符就是

### iOS 快捷指令配置

1. 打开「快捷指令」App，新建一个快捷指令
2. 添加操作「获取剪贴板」
3. 添加操作「URL」，填入 `https://<你的Worker域名>/ingest`
4. 添加操作「获取 URL 内容」，方法改为 **POST**
5. 添加两个请求头：
   - `Content-Type: application/json`
   - `Authorization: Bearer <你的 INGEST_TOKEN>`
6. 请求体改为 JSON，填入：`{"url":"[[剪贴板]]"}`
7. 点编辑页面中间正下方（操作列表底部）的 `i` 图标，开启「在共享表单中显示」开关，然后返回保存
8. 保存后，在任何 App 里复制链接 → 分享按钮 → 下滑找到「一键收录」

### Chrome 插件配置

1. 打开 `chrome://extensions/`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选中项目的 `chrome-extension/` 目录
3. 点击插件图标 → 设置 → 填入 Worker URL 和 INGEST_TOKEN
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
