import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, normalizeIngestPayload, fallbackEnrich, buildPlainTextForRag, enrichWithCoze, createNotionPage } from "../src/worker.js";
import { detectSourcePlatform, buildIngestPayload, buildAuthHeaders, validateOptions } from "../chrome-extension/shared.js";

test("health endpoint works without auth", async () => {
  const res = await handleRequest(new Request("https://kb.example.com/health"), { INGEST_TOKEN: "secret" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("protected endpoint rejects missing token", async () => {
  const res = await handleRequest(new Request("https://kb.example.com/search?q=ai"), { INGEST_TOKEN: "secret" });
  assert.equal(res.status, 401);
});

test("normalize detects platform and strips tracking params", () => {
  const item = normalizeIngestPayload({
    source_url: "https://www.bilibili.com/video/BV123?utm_source=x&foo=bar#hash",
    title: "测试视频",
    text: "AI Agent RAG 内容",
  });
  assert.equal(item.source_platform, "B站");
  assert.equal(item.content_type, "video");
  assert.equal(item.canonical_url, "https://www.bilibili.com/video/BV123?foo=bar");
});

test("normalize tolerates invalid source_url without throwing", () => {
  const item = normalizeIngestPayload({
    source_url: "not a valid url",
    title: "标题",
    text: "正文",
  });
  assert.equal(item.source_platform, "网页");
  assert.equal(item.source_url, "not a valid url");
});

test("fallback enrichment creates summary, category and tags", () => {
  const item = normalizeIngestPayload({ title: "Coze + Dify 做 RAG", text: "用 AI Agent 做个人知识库" });
  const enriched = fallbackEnrich(item);
  assert.equal(enriched.category, "AI技术");
  assert.ok(enriched.tags.includes("AI Agent"));
  assert.ok(enriched.summary.length > 0);
  assert.notEqual(enriched.key_points[0], enriched.summary);
  assert.ok(enriched.key_points.some((point) => point.includes("复用") || point.includes("检索")));
});

test("ingest calls Notion and Dify when configured", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("notion.com")) {
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1" }), { status: 200 });
    }
    if (String(url).includes("create_by_text")) {
      return new Response(JSON.stringify({ document: { id: "doc1" } }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    // capture_device 设为 chrome-extension 走同步模式，返回完整处理结果
    const req = new Request("https://kb.example.com/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ title: "AI知识", text: "RAG 和 Agent", source_url: "https://example.com/a", capture_device: "chrome-extension" }),
    });
    const res = await handleRequest(req, {
      INGEST_TOKEN: "secret",
      NOTION_API_KEY: "notion-token",
      NOTION_DATABASE_ID: "db1",
      DIFY_API_KEY: "dify-token",
      DIFY_DATASET_ID: "dataset1",
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    // 同步模式返回结构：ok / title / notion_page_url（不含 notion_status/vector_status）
    assert.equal(body.ok, true);
    assert.equal(body.notion_page_url, "https://notion.so/page1");
    // 验证确实调用了 Notion 和 Dify（2 个外部调用）
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes("notion.com")), "应调用 Notion API");
    assert.ok(urls.some((u) => u.includes("create_by_text")), "应调用 Dify API");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("LLM enrichment parses OpenAI-compatible response", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          title: "AI 标题",
          summary: "AI 摘要",
          tags: ["企业知识库", "RAG"],
          category: "AI技术",
          entities: "Coze, Dify",
          importance: 4,
          confidence: "高",
          basis: "基于完整正文生成。",
          key_points: ["要点1"],
          source_platform: "网页",
          content_type: "article",
        })
      }
    }]
  }), { status: 200 });

  try {
    const item = normalizeIngestPayload({ title: "原始标题", text: "原始文本", source_url: "https://example.com/a" });
    const enriched = await enrichWithCoze(item, {
      ARK_API_KEY: "ark-key",
      LLM_BASE_URL: "https://api.example.com",
      LLM_MODEL: "test-model",
    });
    assert.equal(enriched.coze_status, "ok");
    // 设计：原始标题（插件抓取）优先，AI 生成的 title 只作兜底
    assert.equal(enriched.title, "原始标题");
    assert.equal(enriched.summary, "AI 摘要");
    assert.deepEqual(enriched.tags, ["企业知识库", "RAG"]);
    assert.equal(enriched.entities, "Coze, Dify");
    assert.equal(enriched.importance, 4);
    assert.equal(enriched.confidence, "高");
    assert.equal(enriched.basis, "基于完整正文生成。");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("tag normalization preserves tags with spaces", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: "摘要",
          tags: "AI Agent, AI Coding, AI Infra, 开发范式",
          category: "AI技术",
        })
      }
    }]
  }), { status: 200 });

  try {
    const item = normalizeIngestPayload({ title: "AI Coding", text: "Agent infra", source_url: "https://example.com/a" });
    const enriched = await enrichWithCoze(item, {
      ARK_API_KEY: "ark-key",
      LLM_BASE_URL: "https://api.example.com",
      LLM_MODEL: "test-model",
    });
    assert.deepEqual(enriched.tags, ["AI Agent", "AI Coding", "AI Infra", "开发范式"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Notion mapping includes enrichment fields", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1" }), { status: 200 });
  };

  try {
    const notion = await createNotionPage({
      title: "AI Coding 方法论",
      summary: "摘要",
      key_points: ["AI Coding 需要工程约束", "TDD 属于具体开发方法"],
      category: "AI技术",
      tags: ["AI Coding", "开发范式", "工程效率"],
      entities: "TDD, Cursor, Claude Code",
      source_platform: "网页",
      content_type: "article",
      captured_at: "2026-06-24T00:00:00.000Z",
      published_at: "2026-06-20",
      author: "作者A",
      importance: 4,
      confidence: "中",
      basis: "基于网页标题和选中文本生成，未获取完整评论区。",
      source_url: "https://example.com/ai-coding",
      privacy: "personal",
      text: "原始文本",
    }, {
      NOTION_API_KEY: "notion-token",
      NOTION_DATABASE_ID: "db1",
    });

    assert.equal(notion.status, "created");
    const payload = JSON.parse(calls[0].init.body);
    assert.deepEqual(payload.properties["Key Points"].rich_text[0].text.content, "1. AI Coding 需要工程约束\n2. TDD 属于具体开发方法");
    assert.equal(payload.properties.Entities.rich_text[0].text.content, "TDD, Cursor, Claude Code");
    assert.equal(payload.properties.Importance.number, 4);
    assert.equal(payload.properties.Confidence.select.name, "中");
    assert.equal(payload.properties.Basis.rich_text[0].text.content, "基于网页标题和选中文本生成，未获取完整评论区。");
    assert.equal(payload.properties.Category.select.name, "AI技术");
    assert.deepEqual(payload.properties.Tags.multi_select.map((x) => x.name), ["AI Coding", "开发范式", "工程效率"]);

    const propertyOrder = Object.keys(payload.properties);
    assert.equal(propertyOrder.indexOf("Source URL"), propertyOrder.indexOf("Entities") + 1);
    assert.equal(propertyOrder.indexOf("Source Platform"), propertyOrder.indexOf("Source URL") + 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("search maps Dify records to stable result shape", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    records: [{
      score: 0.88,
      segment: {
        id: "seg1",
        document_id: "doc1",
        content: "命中片段",
        document: { name: "标题1" },
        metadata: { source_url: "https://example.com", tags: ["AI"] }
      }
    }]
  }), { status: 200 });

  try {
    const req = new Request("https://kb.example.com/search?q=agent&top_k=3", {
      headers: { "x-api-key": "secret" },
    });
    const res = await handleRequest(req, { INGEST_TOKEN: "secret", DIFY_API_KEY: "dify", DIFY_DATASET_ID: "ds" });
    const body = await res.json();
    assert.equal(body.results[0].title, "标题1");
    assert.equal(body.results[0].snippet, "命中片段");
    assert.equal(body.results[0].score, 0.88);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("buildPlainTextForRag includes source links", () => {
  const text = buildPlainTextForRag({
    title: "标题",
    summary: "摘要",
    category: "AI",
    tags: ["RAG"],
    source_platform: "知乎",
    source_url: "https://zhihu.com/x",
    key_points: ["要点1"],
    text: "原文",
  }, { url: "https://notion.so/page" });
  assert.match(text, /标题：标题/);
  assert.match(text, /链接：https:\/\/zhihu.com\/x/);
  assert.match(text, /知识页：https:\/\/notion.so\/page/);
});

// ===== chrome-extension/shared.js 测试 =====

test("detectSourcePlatform identifies common sites", () => {
  assert.equal(detectSourcePlatform("https://www.zhihu.com/question/1"), "知乎");
  assert.equal(detectSourcePlatform("https://www.bilibili.com/video/BV1"), "B站");
  assert.equal(detectSourcePlatform("https://mp.weixin.qq.com/s/xxx"), "微信公众号");
  assert.equal(detectSourcePlatform("https://www.xiaohongshu.com/explore/1"), "小红书");
  assert.equal(detectSourcePlatform("https://www.douyin.com/video/1"), "抖音");
  assert.equal(detectSourcePlatform("https://chatgpt.com/c/abc"), "AI对话");
  assert.equal(detectSourcePlatform("https://example.com/page"), "网页");
});

test("buildIngestPayload uses selected text first and includes metadata", () => {
  const payload = buildIngestPayload({
    tab: { url: "https://zhihu.com/question/1", title: "问题标题" },
    selectionText: "选中文本内容",
    captureMode: "popup",
    publishedAt: "2026-06-20T10:00:00+08:00",
    author: "作者",
  });
  assert.equal(payload.text, "选中文本内容");
  assert.equal(payload.title, "问题标题");
  assert.equal(payload.source_url, "https://zhihu.com/question/1");
  assert.equal(payload.source_platform, "知乎");
  assert.equal(payload.published_at, "2026-06-20T10:00:00+08:00");
  assert.equal(payload.author, "作者");
  assert.equal(payload.capture_device, "chrome-extension");
  assert.equal(payload.capture_mode, "popup");
  assert.equal(payload.content_type, "article");
});

test("buildIngestPayload falls back to title and url when no selected text", () => {
  const payload = buildIngestPayload({
    tab: { url: "https://example.com/a", title: "页面标题" },
    selectionText: "",
    captureMode: "context-menu",
  });
  assert.match(payload.text, /页面标题/);
  assert.match(payload.text, /https:\/\/example.com\/a/);
  assert.equal(payload.capture_mode, "context-menu");
});

test("buildAuthHeaders includes Bearer when token present", () => {
  const h = buildAuthHeaders("tok-123");
  assert.equal(h["Authorization"], "Bearer tok-123");
  assert.match(h["Content-Type"], /json/);
});

test("validateOptions rejects missing config", () => {
  assert.equal(validateOptions({}).ok, false);
  assert.equal(validateOptions({ workerBaseUrl: "https://x.workers.dev", ingestToken: "t" }).ok, true);
});
