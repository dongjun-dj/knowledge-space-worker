import { NOTIFICATION_ICON_PATH, buildFeedbackState, buildIngestPayload, buildNotificationOptions, makeJobId, postToWorker, validateOptions } from "./shared.js";

console.log("🚀 background.js 启动了！Service Worker 已加载");

const DEFAULT_OPTIONS = {
  workerBaseUrl: "",
  ingestToken: "",
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "save-selection-to-kb",
    title: "收录选中内容到知识库",
    contexts: ["selection", "page", "link"],
  });
  const existing = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  await chrome.storage.sync.set({ ...DEFAULT_OPTIONS, ...existing });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-selection-to-kb") return;
  const selectionText = info.selectionText || info.linkUrl || "";
  await saveCurrentPage({ tab, selectionText, captureMode: "context-menu" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("📨 background收到消息:", message);
  
  if (message?.type === "QUEUE_SAVE_CURRENT_PAGE") {
    const jobId = makeJobId();
    sendResponse({ ok: true, queued: true, jobId });
    saveCurrentPage(message)
      .then((result) => showResult({ ok: true, message: result.title || message.tab?.title || "已写入知识库" }))
      .catch((error) => showResult({ ok: false, message: error.message || String(error) }));
    return false;
  }

  if (message?.type !== "SAVE_CURRENT_PAGE") return false;
  saveCurrentPage(message)
    .then((result) => {
      console.log("✅ saveCurrentPage完成:", result);
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      console.log("❌ saveCurrentPage失败:", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function saveCurrentPage({ tab, selectionText = "", captureMode = "popup", publishedAt = "", author = "" }) {
  console.log("📥 background收到请求:", { tab, selectionText: selectionText?.slice(0, 100), captureMode, selectionTextLength: selectionText?.length, publishedAt, author });
  
  const options = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  const valid = validateOptions(options);
  if (!valid.ok) throw new Error(valid.error);
  
  const payload = buildIngestPayload({ tab, selectionText, captureMode, publishedAt, author });
  console.log("📤 构建的payload.text前100字:", payload.text.slice(0, 100));
  console.log("📤 payload.text长度:", payload.text.length);
  console.log("📤 payload.published_at:", payload.published_at || "(空)");
  console.log("📤 payload.author:", payload.author || "(空)");
  console.log("📤 Worker URL:", options.workerBaseUrl);
  console.log("📤 Token存在:", !!options.ingestToken);
  
  try {
    console.log("📤 开始调用postToWorker...");
    const result = await postToWorker({
      workerBaseUrl: options.workerBaseUrl,
      ingestToken: options.ingestToken,
      payload,
    });
    console.log("✅ postToWorker成功:", result);
    return result;
  } catch (error) {
    console.error("❌ postToWorker失败:", error);
    console.error("❌ 错误信息:", error.message);
    console.error("❌ 错误堆栈:", error.stack);
    throw error;
  }
}

function notify(title, message) {
  const iconUrl = chrome.runtime.getURL(NOTIFICATION_ICON_PATH);
  chrome.notifications.create(buildNotificationOptions({ title, message, iconUrl }));
}

async function showResult({ ok, message }) {
  const feedback = buildFeedbackState({ ok, message });
  notify(feedback.title, feedback.message);
  await chrome.action.setBadgeBackgroundColor({ color: feedback.badgeColor });
  await chrome.action.setBadgeText({ text: feedback.badgeText });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
}
