export const NOTIFICATION_ICON_PATH = "icons/icon128.png";

export function normalizeWorkerBaseUrl(value = "") {
  return String(value).trim().replace(/\/+$/, "").replace(/\/ingest$/i, "");
}

export function detectSourcePlatform(url = "") {
  const lower = String(url).toLowerCase();
  if (lower.includes("chatgpt.com")) return "AI对话";
  if (lower.includes("zhihu.com")) return "知乎";
  if (lower.includes("bilibili.com")) return "B站";
  if (lower.includes("mp.weixin.qq.com")) return "微信公众号";
  if (lower.includes("xiaohongshu.com") || lower.includes("xhslink.com")) return "小红书";
  if (lower.includes("douyin.com")) return "抖音";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YouTube";
  if (lower.includes("notion.so")) return "Notion";
  return "网页";
}

export function validateOptions(options = {}) {
  if (!options.workerBaseUrl || !options.ingestToken) {
    return { ok: false, error: "请先在插件选项里填写 Worker URL 和 INGEST_TOKEN。" };
  }
  return { ok: true, error: "" };
}

export function makeJobId(random = Math.random, now = Date.now) {
  return `kb_${now()}_${random().toString(36).slice(2, 10)}`;
}

export function buildFeedbackState({ ok, message } = {}) {
  return {
    title: ok ? "收录成功" : "收录失败",
    message: message || "",
    badgeText: ok ? "✓" : "!",
    badgeColor: ok ? "#16a34a" : "#dc2626",
  };
}

export function buildNotificationOptions({ title, message, iconUrl }) {
  return {
    type: "basic",
    iconUrl,
    title,
    message: String(message || ""),
  };
}

export function buildIngestPayload({ tab = {}, selectionText = "", captureMode = "popup", publishedAt = "", author = "" } = {}) {
  const url = tab.url || "";
  const title = tab.title || "";
  const text = String(selectionText || "").trim() || [title, url].filter(Boolean).join("\n");
  return {
    source_url: url,
    canonical_url: url,
    title,
    text,
    source_platform: detectSourcePlatform(url),
    capture_device: "chrome-extension",
    capture_mode: captureMode,
    privacy: "personal",
    content_type: "article",
    published_at: String(publishedAt || "").trim(),  // ✅ 插件解析出来的平台原始发布时间（ISO格式）
    author: String(author || "").trim(),              // ✅ 插件解析出来的平台原始作者名
  };
}

export function buildAuthHeaders(ingestToken = "") {
  // Chrome Service Worker的fetch有超级傻逼的坑：
  // header里只要有任何非纯ASCII的字符，就会静默卡住，没有任何错误日志！
  // 所以我们这里只保留最基础的Content-Type，其他所有header全删掉！
  return {
    "Content-Type": "application/json; charset=utf-8",
  };
}

export function normalizeIngestToken(value = "") {
  return String(value).trim().replace(/^Bearer\s+/i, "").trim();
}

export async function postToWorker({ workerBaseUrl, ingestToken, payload, fetchImpl = fetch }) {
  const base = normalizeWorkerBaseUrl(workerBaseUrl);
  console.log("📤 准备发请求到:", `${base}/ingest`);
  console.log("📤 请求头:", JSON.stringify(buildAuthHeaders(ingestToken)));

  // ========== 🫀 Service Worker 保活心跳 ==========
  // MV3 SW 空闲 30秒 会被 Chrome kill，中断长请求（Coze分析要20-30s）
  // 每20秒调一次官方API保持"活跃"状态，fetch完成后停止心跳
  // 这是 Google 官方推荐的 keepalive workaround
  let heartbeatCount = 0;
  const heartbeatTimer = setInterval(() => {
    heartbeatCount++;
    // 调用任意一个 chrome.* API 就能保活，getPlatformInfo 是最轻量的
    if (typeof chrome !== "undefined" && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo(() => {
        console.log(`🫀 SW心跳 #${heartbeatCount}（保持活跃防被kill）`);
      });
    }
  }, 20000);  // 20秒 < Chrome的30秒kill阈值，留10秒安全余量

  try {
    console.log("📤 开始发送fetch...");
    const response = await fetchImpl(`${base}/ingest`, {
      method: "POST",
      headers: buildAuthHeaders(ingestToken),
      body: JSON.stringify(payload),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
    console.log("✅ 收到响应，状态码:", response.status);

    let body;
    try {
      body = await response.json();
      console.log("✅ 响应解析成功:", body);
    } catch (e) {
      const text = await response.text();
      console.error("❌ 响应不是JSON:", text.slice(0, 500));
      throw new Error(`响应不是JSON，状态码: ${response.status}，内容: ${text.slice(0, 200)}`);
    }

    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body;
  } catch (error) {
    console.error("❌ 请求异常:", error.name, error.message);
    throw error;
  } finally {
    // 无论成功失败，都要停止心跳，否则会一直空转浪费资源
    clearInterval(heartbeatTimer);
    console.log(`🫀 心跳已停止（总共${heartbeatCount}次心跳）`);
  }
}
