import { normalizeIngestToken, normalizeWorkerBaseUrl, postToWorker, validateOptions } from "./shared.js";

const DEFAULT_WORKER = "";
const workerEl = document.querySelector("#workerBaseUrl");
const tokenEl = document.querySelector("#ingestToken");
const statusEl = document.querySelector("#status");

const saved = await chrome.storage.sync.get({ workerBaseUrl: DEFAULT_WORKER, ingestToken: "" });
workerEl.value = saved.workerBaseUrl || DEFAULT_WORKER;
tokenEl.value = normalizeIngestToken(saved.ingestToken || "");

document.querySelector("#save").addEventListener("click", saveOptions);
document.querySelector("#test").addEventListener("click", testConnection);

async function saveOptions() {
  const options = currentOptions();
  const valid = validateOptions(options);
  if (!valid.ok) {
    statusEl.textContent = valid.error;
    return null;
  }
  await chrome.storage.sync.set(options);
  tokenEl.value = options.ingestToken;
  statusEl.textContent = "已保存。现在可以点击插件图标或右键菜单收录。";
  return options;
}

function currentOptions() {
  return {
    workerBaseUrl: normalizeWorkerBaseUrl(workerEl.value || DEFAULT_WORKER),
    ingestToken: normalizeIngestToken(tokenEl.value),
  };
}

async function testConnection() {
  const options = await saveOptions();
  if (!options) return;
  statusEl.textContent = "正在测试连接...";
  try {
    const result = await postToWorker({
      workerBaseUrl: options.workerBaseUrl,
      ingestToken: options.ingestToken,
      payload: {
        title: "Chrome 插件连接测试",
        text: "这是 Chrome 插件设置页发起的连接测试。",
        source_url: "https://example.com/chrome-extension-test",
        source_platform: "网页",
        capture_device: "chrome-extension-options",
        privacy: "personal",
        content_type: "article",
      },
    });
    statusEl.textContent = `测试成功：${result.notion_status || "ok"} ${result.title || ""}`;
  } catch (error) {
    statusEl.textContent = `测试失败：${error.message || error}`;
  }
}
