import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NOTIFICATION_ICON_PATH,
  buildFeedbackState,
  buildIngestPayload,
  buildNotificationOptions,
  detectSourcePlatform,
  makeJobId,
  normalizeIngestToken,
  normalizeWorkerBaseUrl,
  postToWorker,
  validateOptions,
} from "../chrome-extension/shared.js";

test("manifest declares every icon file that exists in the extension package", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(testDir, "..");
  const manifestPath = path.join(projectRoot, "chrome-extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const iconPath of Object.values(manifest.icons)) {
    assert.equal(fs.existsSync(path.join(projectRoot, "chrome-extension", iconPath)), true, `${iconPath} should exist`);
  }
});

test("notification icon uses png because Chrome notifications cannot load svg reliably", () => {
  assert.equal(NOTIFICATION_ICON_PATH, "icons/icon128.png");
});

test("buildNotificationOptions uses an absolute extension icon URL", () => {
  assert.deepEqual(
    buildNotificationOptions({ title: "收录成功", message: "done", iconUrl: "chrome-extension://abc/icons/icon128.png" }),
    {
      type: "basic",
      iconUrl: "chrome-extension://abc/icons/icon128.png",
      title: "收录成功",
      message: "done",
    }
  );
});

test("buildFeedbackState uses notification plus badge, not result window", () => {
  assert.deepEqual(buildFeedbackState({ ok: true, message: "AI Agent" }), {
    title: "收录成功",
    message: "AI Agent",
    badgeText: "✓",
    badgeColor: "#16a34a",
  });
  assert.deepEqual(buildFeedbackState({ ok: false, message: "bad" }), {
    title: "收录失败",
    message: "bad",
    badgeText: "!",
    badgeColor: "#dc2626",
  });
});

test("normalizeWorkerBaseUrl removes trailing slashes and /ingest suffix", () => {
  assert.equal(normalizeWorkerBaseUrl("https://knowledge-space-worker.dj-knowledge.workers.dev/ingest/"), "https://knowledge-space-worker.dj-knowledge.workers.dev");
  assert.equal(normalizeWorkerBaseUrl(" https://example.com/// "), "https://example.com");
});

test("detectSourcePlatform identifies common sites", () => {
  assert.equal(detectSourcePlatform("https://chatgpt.com/c/abc"), "chatgpt");
  assert.equal(detectSourcePlatform("https://www.zhihu.com/question/1"), "zhihu");
  assert.equal(detectSourcePlatform("https://www.bilibili.com/video/BV1"), "bilibili");
  assert.equal(detectSourcePlatform("https://mp.weixin.qq.com/s/abc"), "wechat");
  assert.equal(detectSourcePlatform("https://example.com"), "web");
});

test("buildIngestPayload uses selected text first and includes extension metadata", () => {
  const payload = buildIngestPayload({
    tab: { url: "https://chatgpt.com/c/abc", title: "ChatGPT - Notion API Key" },
    selectionText: "这是一段选中的对话内容",
    captureMode: "popup",
  });
  assert.equal(payload.source_url, "https://chatgpt.com/c/abc");
  assert.equal(payload.title, "ChatGPT - Notion API Key");
  assert.equal(payload.text, "这是一段选中的对话内容");
  assert.equal(payload.source_platform, "chatgpt");
  assert.equal(payload.capture_device, "chrome-extension");
  assert.equal(payload.capture_mode, "popup");
  assert.equal(payload.privacy, "personal");
});

test("buildIngestPayload falls back to title and url when no selected text", () => {
  const payload = buildIngestPayload({ tab: { url: "https://example.com/post", title: "Example Post" }, selectionText: "" });
  assert.equal(payload.text, "Example Post\nhttps://example.com/post");
  assert.equal(payload.source_platform, "web");
});

test("validateOptions requires worker url and token", () => {
  assert.deepEqual(validateOptions({ workerBaseUrl: "", ingestToken: "" }), { ok: false, error: "请先在插件选项里填写 Worker URL 和 INGEST_TOKEN。" });
  assert.deepEqual(validateOptions({ workerBaseUrl: "https://example.com", ingestToken: "kb_x" }), { ok: true, error: "" });
});

test("normalizeIngestToken accepts raw token or Bearer-prefixed token", () => {
  assert.equal(normalizeIngestToken("  abc123  "), "abc123");
  assert.equal(normalizeIngestToken("Bearer abc123"), "abc123");
  assert.equal(normalizeIngestToken("bearer   abc123  "), "abc123");
});

test("postToWorker sends both Authorization and X-API-Key headers", async () => {
  const calls = [];
  const result = await postToWorker({
    workerBaseUrl: "https://knowledge-space-worker.dj-knowledge.workers.dev/ingest/",
    ingestToken: "Bearer abc123",
    payload: { title: "测试" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, title: "测试" }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://knowledge-space-worker.dj-knowledge.workers.dev/ingest");
  assert.equal(calls[0].init.headers.Authorization, "Bearer abc123");
  assert.equal(calls[0].init.headers["X-API-Key"], "abc123");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("makeJobId creates unique async job ids", () => {
  const id = makeJobId(() => 0.123456789, () => 1710000000000);
  assert.match(id, /^kb_1710000000000_[a-z0-9]+$/);
});
