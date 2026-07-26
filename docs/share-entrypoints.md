# 一键分享入口

部署 Worker 后，假设你的地址是：

```text
https://knowledge-space-worker.xxx.workers.dev
```

并且你的密钥是：

```text
INGEST_TOKEN=你的密钥
```

## 1. iPhone 快捷指令

创建一个新的快捷指令，名称建议：`收录到知识库`。

动作：

1. 接收共享表单输入：URL、文本、图片。
2. 获取共享输入中的 URL。
3. 获取共享输入中的文本。
4. URL 内容：`https://你的-worker-url/ingest`
5. 方法：POST。
6. Headers：

```text
Authorization: Bearer 你的_INGEST_TOKEN
Content-Type: application/json
```

7. Body JSON：

```json
{
  "source_url": "快捷指令获取到的URL",
  "text": "快捷指令获取到的文本",
  "source_platform": "auto",
  "capture_device": "ios",
  "privacy": "personal"
}
```

8. 显示结果：`已收录：title / summary`。

后续我可以在你手机上逐步帮你点快捷指令配置。

## 2. Chrome Bookmarklet

新建一个书签，URL 填下面内容。把其中 `WORKER_URL` 和 `TOKEN` 替换成你的真实值。

```javascript
javascript:(async()=>{const u='WORKER_URL/ingest';const token='TOKEN';const payload={source_url:location.href,title:document.title,text:String(window.getSelection&&window.getSelection()||''),source_platform:'auto',capture_device:'chrome',privacy:'personal'};const r=await fetch(u,{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();alert(j.ok?'已收录：'+j.title+'\n'+(j.summary||''):'收录失败：'+(j.error||JSON.stringify(j)));})();
```

使用方式：

1. 看到好文章；
2. 可选：先选中重点文字；
3. 点击书签；
4. 等提示“已收录”。

## 3. curl 测试

```bash
curl -X POST "https://你的-worker-url/ingest" \
  -H "Authorization: Bearer 你的_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://example.com/a",
    "title": "测试文章",
    "text": "这是一条测试内容",
    "source_platform": "网页",
    "capture_device": "curl",
    "privacy": "personal"
  }'
```

## 4. 本地文档导入

MVP 先支持把文档文本或文件链接传入 `/ingest`。

如果你要导入本地 PDF/Word，可以先用本地脚本提取文本，再 POST：

```json
{
  "title": "本地文档名称",
  "text": "提取出来的正文",
  "file_url": "可选，云端文件链接",
  "source_platform": "本地文档",
  "content_type": "pdf",
  "capture_device": "local",
  "privacy": "work"
}
```

后续可以扩展：自动监听一个本地文件夹，新增文件自动上传和入库。
