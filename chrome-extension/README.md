# Chrome 插件 MVP：收录到知识库

## 功能

- 点击插件图标：提交后台收录当前页面 URL、标题、选中文本，弹窗会自动关闭。
- 右键菜单：收录选中文本/当前页/链接。
- 调用线上 Worker `/ingest`，继续走 Coze + Notion。
- 完成或失败后通过 Chrome 系统通知提示结果；插件图标也会短暂显示 ✓ / ! 角标。
- INGEST_TOKEN 保存在 Chrome 本地同步存储，不写死在代码里。

## 安装

1. Chrome 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择目录：

```text
/Users/dj/knowledge-space-worker/chrome-extension
```

## 配置

1. 加载插件后，点击「详情」或右键插件图标 →「选项」。
2. Worker URL 填你部署后得到的地址（去掉 `/admin?...` 部分，形如）：

```text
https://<你的Worker域名>.workers.dev
```

3. INGEST_TOKEN 填当前有效 token。
4. 点击「保存设置」。

## 使用

- 普通收录：打开网页 → 点击插件图标 →「收录当前页/选中文本」。
- 选中文本收录：选中一段文字 → 右键 →「收录选中内容到知识库」。

## 注意

- 如果在 ChatGPT 等网页上，Bookmarklet 因 CSP 失败，插件通常可正常发送请求。
- `chrome://`、Chrome Web Store、部分浏览器内置页不能注入脚本，这类页面无法读取选中文本，但仍可尝试保存标题和 URL。
- 不要截图外发完整 INGEST_TOKEN。
