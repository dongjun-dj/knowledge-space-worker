export function renderApp() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>知识库链接提取器</title>
  <style>
    :root{color-scheme:light;--ink:#18201b;--muted:#68736c;--line:#dce4de;--paper:#f7f9f7;--card:#fff;--brand:#176b45;--brand2:#0f5133;--danger:#b42318}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#edf5ef,#faf9f3 46%,#edf1f6);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
    main{width:min(980px,calc(100% - 32px));margin:52px auto}.hero{margin-bottom:24px}.eyebrow{color:var(--brand);font-weight:700;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-family:ui-serif,Georgia,"Songti SC",serif;font-size:clamp(32px,6vw,54px);line-height:1.08;margin:8px 0 12px}.hero p{color:var(--muted);font-size:17px;margin:0;max-width:650px}
    .card{background:rgba(255,255,255,.92);border:1px solid rgba(220,228,222,.9);border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(40,60,48,.09);backdrop-filter:blur(12px)}
    .grid{display:grid;grid-template-columns:1fr auto;gap:12px}.field{margin-bottom:16px}label{display:block;font-weight:700;margin-bottom:7px}input,textarea,button{font:inherit}input,textarea{width:100%;border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:#fff;color:var(--ink);outline:none}input:focus,textarea:focus{border-color:#65a983;box-shadow:0 0 0 3px #dff1e6}textarea{min-height:110px;resize:vertical}
    button{border:0;border-radius:11px;padding:12px 18px;font-weight:700;cursor:pointer}.primary{background:var(--brand);color:#fff;min-width:120px}.primary:hover{background:var(--brand2)}button:disabled{opacity:.55;cursor:wait}.secondary{background:#edf4ef;color:var(--brand2)}
    .hint{color:var(--muted);font-size:13px;margin-top:6px}.status{margin:18px 0 0;padding:12px 14px;border-radius:10px;background:var(--paper);color:var(--muted)}.status.error{background:#fff1f0;color:var(--danger)}.status.ok{background:#eaf7ef;color:var(--brand2)}
    .result{display:none;margin-top:24px}.result.show{display:block}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.metric{background:var(--paper);border-radius:10px;padding:10px 12px}.metric b{display:block;font-size:20px}.metric span{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:8px;justify-content:flex-end;margin-bottom:8px}pre{white-space:pre-wrap;word-break:break-word;background:#17211b;color:#e9f4ed;border-radius:12px;padding:18px;max-height:560px;overflow:auto;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
    footer{color:var(--muted);font-size:13px;text-align:center;margin-top:18px}@media(max-width:680px){main{margin:28px auto}.grid{grid-template-columns:1fr}.meta{grid-template-columns:1fr 1fr}.primary{width:100%}}
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">Knowledge Extractor</div>
    <h1>把链接变成干净的知识文本</h1>
    <p>支持小红书正文与图片、B站带时间戳字幕、知乎文章和回答。</p>
  </section>
  <section class="card">
    <form id="form">
      <div class="field">
        <label for="token">访问令牌</label>
        <input id="token" type="password" autocomplete="off" placeholder="API Token" required>
        <div class="hint">仅保存在当前浏览器会话，关闭标签页后清除。</div>
      </div>
      <div class="field">
        <label for="url">内容链接</label>
        <div class="grid">
          <textarea id="url" placeholder="粘贴小红书、B站或知乎链接；分享文案中包含链接也可以" required></textarea>
          <button id="submit" class="primary" type="submit">开始提取</button>
        </div>
      </div>
    </form>
    <div id="status" class="status">等待输入链接</div>
    <section id="result" class="result">
      <div class="meta">
        <div class="metric"><b id="platform">—</b><span>平台</span></div>
        <div class="metric"><b id="bodyLength">0</b><span>正文字数</span></div>
        <div class="metric"><b id="lines">0</b><span>字幕行数</span></div>
        <div class="metric"><b id="images">0</b><span>图片数量</span></div>
      </div>
      <div class="toolbar">
        <button id="copy" class="secondary" type="button">复制 Markdown</button>
        <button id="download" class="secondary" type="button">下载 .md</button>
      </div>
      <pre id="output"></pre>
    </section>
  </section>
  <footer>只归档你有权访问和保存的内容</footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const form = $("form"), token = $("token"), url = $("url"), submit = $("submit");
  const status = $("status"), result = $("result"), output = $("output");
  let markdown = "", filename = "extracted.md";
  token.value = sessionStorage.getItem("knowledgeExtractorToken") || "";

  function extractUrl(text) {
    const match = text.match(/https?:\\/\\/[^\\s；;]+/i);
    return match ? match[0].replace(/[。，、!！?？~～]+$/g, "") : text.trim();
  }
  function setStatus(message, kind = "") {
    status.textContent = message;
    status.className = "status" + (kind ? " " + kind : "");
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    sessionStorage.setItem("knowledgeExtractorToken", token.value);
    submit.disabled = true;
    result.classList.remove("show");
    setStatus("正在提取，请稍候…");
    try {
      const response = await fetch("/extract", {
        method: "POST",
        headers: {"Authorization": "Bearer " + token.value, "Content-Type": "application/json"},
        body: JSON.stringify({url: extractUrl(url.value)})
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "提取失败");
      const doc = data.document;
      markdown = data.markdown;
      filename = (doc.title || "extracted").replace(/[\\\\/:*?"<>|]/g, "_").slice(0, 80) + ".md";
      $("platform").textContent = doc.platform;
      $("bodyLength").textContent = (doc.body || "").length.toLocaleString();
      $("lines").textContent = (doc.transcript || []).length.toLocaleString();
      $("images").textContent = (doc.images || []).length.toLocaleString();
      output.textContent = markdown;
      result.classList.add("show");
      setStatus("提取成功：" + doc.title, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(markdown);
    setStatus("Markdown 已复制", "ok");
  });
  $("download").addEventListener("click", () => {
    const blob = new Blob([markdown], {type:"text/markdown;charset=utf-8"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = filename; link.click();
    URL.revokeObjectURL(link.href);
  });
</script>
</body>
</html>`;
}
