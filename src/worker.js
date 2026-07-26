import { ADMIN_HTML } from "./admin.html.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

// ============ 监控日志辅助 ============
function buildLogRow(requestId, rawInput, result, durationMs) {
  const now = new Date().toISOString();
  // 解析 jina_status: "ok_200_len17685_9132ms"
  let jinaTextLength = null;
  const js = result.jina_status || "";
  const m = js.match(/len(\d+)/);
  if (m) jinaTextLength = parseInt(m[1], 10);

  // 状态归一化：
  // - ok        = 抓成功 + Notion 成功
  // - blocked   = 命中登录墙/验证页/反爬
  // - recovered = Wayback 兜底救回来了
  // - partial   = 抓到了但 Notion 写入失败
  // - error     = 整个流程失败
  const quality = result._quality || "";
  let status = "error";
  if (result.ok) {
    if (quality === "blocked") status = "blocked";
    else if (quality === "wayback_recovered") status = "recovered";
    else if (result.notion_status === "ok") status = "ok";
    else if (result.notion_status === "error") status = "partial";
    else status = "ok";
  }

  return [
    now,
    requestId,
    rawInput?.source_url || "",
    result.title || rawInput?.title || "",
    rawInput?.source_platform || result.source_platform || "",
    rawInput?.capture_device || "",
    status,
    JSON.stringify(rawInput || {}),
    js || "",
    jinaTextLength,
    JSON.stringify(result.debug_coze_input || {}),
    JSON.stringify(result.debug_coze_parsed || {}),
    result.coze_error || "",
    "",
    result.notion_page_url || "",
    result.notion_status || "",
    result.notion_error || "",
    durationMs,
    result.error || "",
  ];
}

const DEFAULT_CATEGORIES = [
  "AI技术",
  "云计算与基础设施",
  "软件工程",
  "数据与安全",
  "其他技术",
  "行业研究",
  "商业与管理",
  "效率工具",
  "个人成长",
  "宏观与社会",
  "其他",
];

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    const resp = new Response(null, { status: 204 });
    resp.headers.set("access-control-allow-origin", "*");
    resp.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
    resp.headers.set("access-control-allow-headers", "authorization,content-type,x-api-key");
    resp.headers.set("access-control-max-age", "86400");
    return resp;
  }

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(json({ ok: true, service: "knowledge-space-worker", time: new Date().toISOString() }));
    }

    const auth = authorize(request, env);
    if (!auth.ok) {
      return withCors(json({ ok: false, error: auth.error }, 401));
    }

      if (url.pathname === "/ingest" && request.method === "POST") {
        const input = await readJson(request);
        const startedAt = Date.now();
        const requestId = crypto.randomUUID();
        const result = await ingest(input, env);
        const durationMs = Date.now() - startedAt;

        // 🆕 iOS + 抓到登录墙 → 自动入队等桌面消费
        // Chrome 插件失败一般是用户选中操作，不入队
        const captureDevice = String(input.capture_device || "").toLowerCase();
        const quality = result._quality || "";
        const shouldQueue = captureDevice === "ios" && (quality === "blocked" || quality === "jina_error");
        if (shouldQueue && env.kb_logs) {
          const queueTask = env.kb_logs
            .prepare(`INSERT INTO pending_queue (
              created_at, request_id, source_url, title, reason, capture_device, raw_payload
            ) VALUES (?,?,?,?,?,?,?)`)
            .bind(
              new Date().toISOString(),
              requestId,
              input.source_url || input.url || "",
              input.title || "",
              quality,
              captureDevice,
              JSON.stringify(input).slice(0, 8000)
            )
            .run()
            .catch((e) => console.error("[queue] D1 入队失败:", e.message));
          if (ctx?.waitUntil) ctx.waitUntil(queueTask);
        }

        // 🆕 异步写入监控日志（不阻塞用户响应）
        if (env.kb_logs) {
          const logRow = buildLogRow(requestId, input, result, durationMs);
          const writeTask = env.kb_logs
            .prepare(`INSERT INTO ingest_logs (
              created_at, request_id, source_url, title, source_platform, capture_device,
              status, raw_payload, jina_status, jina_text_length,
              coze_input, coze_output, coze_error,
              notion_page_id, notion_page_url, notion_status, notion_error,
              duration_ms, error
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(...logRow)
            .run()
            .catch((e) => console.error("[monitor] D1 写入失败:", e.message));
          if (ctx?.waitUntil) ctx.waitUntil(writeTask);
        }

        // ✅ 终极调试方案：所有你需要的信息直接在响应里返回！
        return withCors(json({
          ...result,
          request_id: requestId,
          debug_info: {
            time: new Date().toISOString(),
            copy_this_to_coze: result.debug_coze_input,
            coze_raw_body: result.debug_coze_raw_body,
            coze_parsed: result.debug_coze_parsed,
            coze_category: result.category,
            coze_confidence: result.confidence,
            coze_tags: result.tags,
            coze_summary: result.summary,
          },
        }, result.ok ? 200 : 400));
      }

    // 🆕 /admin 监控台静态页面（用 URL 参数 token 认证）
    if (url.pathname === "/admin" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return new Response("Unauthorized. Use /admin?token=YOUR_TOKEN", { status: 401 });
      }
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // 🆕 /api/logs 返回监控日志 JSON
    if (url.pathname === "/api/logs" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not bound" }, 500));

      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
      const status = url.searchParams.get("status") || "";
      const q = url.searchParams.get("q") || "";
      let sql = "SELECT * FROM ingest_logs";
      const conditions = [];
      const binds = [];
      if (status) { conditions.push("status = ?"); binds.push(status); }
      if (q) {
        conditions.push("(source_url LIKE ? OR title LIKE ? OR source_platform LIKE ?)");
        const like = `%${q}%`;
        binds.push(like, like, like);
      }
      if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
      sql += ` ORDER BY id DESC LIMIT ?`;
      binds.push(limit);

      const { results } = await env.kb_logs.prepare(sql).bind(...binds).all();
      // 顺便返回总统计
      const stats = await env.kb_logs.prepare(
        "SELECT status, COUNT(*) as cnt FROM ingest_logs GROUP BY status"
      ).all();
      return withCors(json({ ok: true, logs: results, stats: stats.results }));
    }

    // 🆕 待收录队列 API
    // GET /api/queue?token=xxx → 拉队列（默认 pending）
    if (url.pathname === "/api/queue" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not bound" }, 500));
      const status = url.searchParams.get("status") || "pending";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const { results } = await env.kb_logs.prepare(
        `SELECT * FROM pending_queue WHERE status = ? ORDER BY id DESC LIMIT ?`
      ).bind(status, limit).all();
      const stats = await env.kb_logs.prepare(
        "SELECT status, COUNT(*) as cnt FROM pending_queue GROUP BY status"
      ).all();
      return withCors(json({ ok: true, queue: results, stats: stats.results }));
    }

    // POST /api/queue/consume { id, notion_page_id } → 标记已消费
    if (url.pathname === "/api/queue/consume" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const body = await readJson(request);
      const id = parseInt(body.id, 10);
      if (!id) return withCors(json({ ok: false, error: "missing id" }, 400));
      await env.kb_logs.prepare(
        `UPDATE pending_queue SET status='consumed', consumed_at=?, notion_page_id=? WHERE id=?`
      ).bind(new Date().toISOString(), body.notion_page_id || null, id).run();
      return withCors(json({ ok: true }));
    }

    // POST /api/queue/abandon { id } → 放弃这条
    if (url.pathname === "/api/queue/abandon" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const body = await readJson(request);
      const id = parseInt(body.id, 10);
      if (!id) return withCors(json({ ok: false, error: "missing id" }, 400));
      await env.kb_logs.prepare(
        `UPDATE pending_queue SET status='abandoned' WHERE id=?`
      ).bind(id).run();
      return withCors(json({ ok: true }));
    }

    if (url.pathname === "/search" && request.method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      const topK = numberFrom(url.searchParams.get("top_k"), numberFrom(env.DEFAULT_TOP_K, 5));
      if (!q) return withCors(json({ ok: false, error: "missing query param: q" }, 400));
      const result = await searchKnowledge(q, topK, env);
      return withCors(json(result));
    }

    return withCors(json({ ok: false, error: "not found" }, 404));
  } catch (error) {
    return withCors(json({ ok: false, error: error.message || String(error) }, 500));
  }
}

export async function ingest(input, env = {}) {
  const normalized = normalizeIngestPayload(input);
  // ✅ iOS快捷指令场景：text字段可能只是URL（因为Shortcuts抓不到网页正文）
  // 检测到这种情况就用 Jina Reader 抓取真实正文替换掉
  await fetchArticleIfNeeded(normalized, env);
  const enriched = await enrichWithCoze(normalized, env);
  const notion = await createNotionPage(enriched, env);
  const vector = await indexDify(enriched, notion, env);

  return {
    ok: true,
    id: enriched.id,
    title: enriched.title,
    summary: enriched.summary,
    key_points: enriched.key_points,
    category: enriched.category,
    tags: enriched.tags,
    entities: enriched.entities,
    source_platform: enriched.source_platform,
    published_at: enriched.published_at,
    author: enriched.author,
    importance: enriched.importance,
    confidence: enriched.confidence,
    basis: enriched.basis,
    coze_status: enriched.coze_status,
    coze_error: enriched.coze_error || undefined,
    notion_page_url: notion.url || null,
    notion_status: notion.status,
    notion_error: notion.error || undefined,
    vector_status: vector.status,
    vector_document_id: vector.document_id || null,
    // 🔍 调试字段：透传给上层debug_info
    debug_coze_input: enriched.debug_coze_input,
    debug_coze_parsed: enriched.debug_coze_parsed,
    debug_coze_raw_body: enriched.debug_coze_raw_body,
    // 🔍 Jina Reader抓取状态
    jina_status: normalized._jina_status || null,
    jina_error: normalized._jina_error || null,
    // 🆕 抓取质量 + Wayback 兜底状态
    _quality: normalized._quality || null,
    _wayback_status: normalized._wayback_status || null,
  };
}

export async function searchKnowledge(query, topK = 5, env = {}) {
  const dify = await retrieveDify(query, topK, env);
  return {
    ok: true,
    query,
    results: dify.results,
    source: dify.source,
  };
}

function normalizeSourcePlatform(sourcePlatform, host = "") {
  const platformLower = String(sourcePlatform || "").toLowerCase().trim();
  const hostLower = String(host || "").toLowerCase().trim();

  // 标准化成中文，不管输入是英文还是中文
  const mapping = [
    [["zhihu", "知乎"], "知乎"],
    [["bilibili", "b站", "bilibil", "bili"], "B站"],
    [["xiaohongshu", "小红书", "xhs"], "小红书"],
    [["douyin", "抖音"], "抖音"],
    [["weixin", "微信", "公众号", "微信公众号", "mp.weixin.qq.com"], "微信公众号"],
    [["chatgpt", "openai", "gpt", "豆包", "doubao", "claude", "anthropic"], "AI对话"],
    [["网页", "web", "website", "article"], "网页"],
  ];

  // 先匹配输入的 sourcePlatform
  for (const [keywords, result] of mapping) {
    if (keywords.some((k) => platformLower.includes(k))) {
      return result;
    }
  }

  // 再从 host 推断
  for (const [keywords, result] of mapping) {
    if (keywords.some((k) => hostLower.includes(k))) {
      return result;
    }
  }

  return "网页";
}

export function normalizeIngestPayload(input) {
  const host = new URL(input.source_url || "https://example.com").hostname;
  const sourcePlatform = normalizeSourcePlatform(input.source_platform, host);
  const text = stringOrEmpty(input.text || input.raw_text || input.content).trim();
  // 清洗标题：去掉知乎的私信、消息、后缀等垃圾信息
  function cleanTitle(title) {
    if (!title) return "";
    return title
      .replace(/^\(\d+\+? 封私信 \/ \d+ 条消息\)\s*/, "")
      .replace(/^\(\d+\+? 封私信\)\s*/, "")
      .replace(/^\(\d+ 条消息\)\s*/, "")
      .replace(/^\(\d+\+? 条新消息\)\s*/, "")
      .replace(/\s*-\s*知乎\s*$/g, "")
      .replace(/\s*-\s*知乎专栏\s*$/g, "")
      .replace(/\s*-\s*知乎日报\s*$/g, "")
      .replace(/\s*-\s*知乎盐选\s*$/g, "")
      .trim();
  }

  const title = cleanTitle(stringOrEmpty(input.title).trim()) || guessTitle(text, input.source_url);
  const sourceUrl = stringOrEmpty(input.source_url || input.url).trim();
  const canonicalUrl = stringOrEmpty(input.canonical_url || input.canonicalUrl).trim() || sourceUrl;

  return {
    id: `ki_${cryptoRandomId()}`,
    title,
    source_url: sourceUrl,
    canonical_url: canonicalizeUrl(sourceUrl),
    text,
    images: Array.isArray(input.images) ? input.images.filter(Boolean) : [],
    file_url: stringOrEmpty(input.file_url),
    source_platform: sourcePlatform,
    capture_device: stringOrEmpty(input.capture_device || "unknown"),
    privacy: stringOrEmpty(input.privacy || "personal"),
    content_type: inferContentType(input, sourceUrl),
    captured_at: new Date().toISOString(),
    // ✅ 从input读取插件端解析好的ISO日期，没有则空
    published_at: stringOrEmpty(input.published_at || input.publishedAt),
    // ✅ 从input读取插件端解析好的作者名，没有则空（Coze也可能生成，最终由mergeEnrichment仲裁）
    author: stringOrEmpty(input.author),
  };
}

// ========== 🕷️ Jina Reader 抓取网页正文 ==========
// 场景：iOS快捷指令等只能传URL的场景，Worker端主动去抓正文
// 触发条件：
//   1. text字段是纯URL（长度短、以http开头）
//   2. text几乎为空
//   3. text太短（<800字符，说明Safari阅读器抽取不全，用Jina兜底补充）
// 免费额度：Jina API Key 200 QPM，个人使用足够
export async function fetchArticleIfNeeded(item, env = {}) {
  const text = String(item.text || "").trim();
  const url = String(item.source_url || "").trim();
  const captureDevice = String(item.capture_device || "").toLowerCase();

  // 判定：text 是否就是一个URL（正文极短且以http开头）
  const textIsJustUrl = text.length < 500 && /^https?:\/\//i.test(text);
  const textIsMissing = text.length < 50 && url;
  // 🆕 iOS Safari阅读器可能抽取不全，短于800字符时用Jina补一遍
  // ⚠️ 只对iOS快捷指令生效，Chrome插件抓到的DOM即使短也不能覆盖（避免Jina撞验证墙倒吞好内容）
  const textTooShort = captureDevice === "ios" 
    && text.length > 0 
    && text.length < 800 
    && url 
    && !/^https?:\/\//i.test(text);

  if (!textIsJustUrl && !textIsMissing && !textTooShort) {
    console.log(`[Jina] 跳过抓取，text已有正文（长度：${text.length}，device：${captureDevice}）`);
    return;
  }

  if (textTooShort) {
    console.log(`[Jina] 触发原因: iOS text只有${text.length}字符（可能是Safari阅读器抽取不全）`);
  }

  if (!url) {
    console.log("[Fetch] 跳过抓取，无source_url");
    return;
  }

  // 🆕 已知 App 独占分享域名 / 路径 —— 网页里根本没内容，直接跳过抓取，节省 credit
  // 这些链接只在 App 内能看，任何抓手都救不了
  const appOnlyPatterns = [
    /^https?:\/\/oia\.zhihu\.com\//i,       // 知乎盐选/付费/App 分享
    /\/km_paid_content\//i,                  // 知乎付费专栏
    /^https?:\/\/oia\.mp\.weixin\.qq\.com\//i, // 微信 App 独占分享（如果有）
  ];
  if (appOnlyPatterns.some(re => re.test(url))) {
    console.log(`[Fetch] ⚠️ 已知 App 独占分享链，网页版无内容，跳过抓取：${url}`);
    item._jina_status = "skip_app_only_domain";
    item._quality = "app_only";
    // 保留原 text（会是那个 App 引导页 markdown），供后续人工识别
    return;
  }

  // ==================== 🎬 B 站分支：优先 得到大脑开放平台 获取完整字幕（官方 API） ====================
  // 强制进分支，只要 DEDAO_API_KEY 存在就进 —— 排查为什么没进去
  if (env.DEDAO_API_KEY && /(bilibili\.com|b23\.tv)/i.test(url)) {
    try {
      const startTime = Date.now();
      // 得到大脑开放平台官方 API：创建笔记（自动提取 B 站字幕）
      const apiUrl = "https://openapi.biji.com/open/api/v1/resource/note/create";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // 强制 90 秒超时
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "X-Client-ID": env.DEDAO_CLIENT_ID,
          "Authorization": env.DEDAO_API_KEY,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        },
        body: JSON.stringify({ url }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`[Dedao-B站] ❌ HTTP ${resp.status}，停止：${errText.slice(0, 200)}`);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`);
      }
      const data = await resp.json();
      // 官方返回格式：{success: true, data: {title: "xxx", content: "完整字幕markdown"}}
      if (data.success && data.data && data.data.content && data.data.content.trim().length > 100) {
        item.text = data.data.content;
        // 标题覆写
        if (data.data.title && data.data.title.trim().length > 5) {
          const currTitle = String(item.title || "").trim();
          if (!currTitle || /^https?:\/\//i.test(currTitle)) {
            item.title = data.data.title.trim();
          }
        }
        item._jina_status = `dedao_bilibili_ok_${Date.now() - startTime}ms_full-text`;
        item._fetcher = "dedao_bilibili";
        item._quality = "ok";
        console.log(`[Dedao-B站] ✅ ${Date.now() - startTime}ms，full text ${data.data.content.length} chars`);
        // 拿到了就不继续兜底 —— 用户要求只测连通性
        return;
      } else {
        const msg = data.error?.message || "content too short or empty";
        console.log(`[Dedao-B站] ❌ ${msg}（${(data.data?.content||'').length} chars），停止`);
        throw new Error(msg);
      }
    } catch (e) {
      console.log(`[Dedao-B站] ❌ 失败：${e.message}，不兜底，直接返回`);
      item._jina_status = `dedao_bilibili_fail:${e.message}`;
      item._fetcher = "dedao_bilibili";
      item._quality = "fail";
      // 不降级，直接继续往后 —— 但 item._quality=fail，最终会返回错误给你看
    }
  }

  // ==================== 🎬 B 站分支：走 TikHub 结构化 API（免费额度） ====================
  if (env.TIKHUB_API_KEY && /(bilibili\.com|b23\.tv)/i.test(url)) {
    try {
      const bili = await fetchFromTikhubBilibili(url, env);
      if (bili.ok && bili.markdown) {
        if (!item.text) item.text = bili.markdown; // 如果 得到大脑 已经拿了 text，这里就不覆盖了
        // 覆写 title / author / published_at / 封面（只在原字段空/是 URL 时覆盖）
        const currTitle = String(item.title || "").trim();
        if (bili.title && (!currTitle || /^https?:\/\//i.test(currTitle) || currTitle.length < 5)) {
          item.title = bili.title;
        }
        if (bili.author && !item.author) item.author = bili.author;
        if (bili.published_at && !item.published_at) item.published_at = bili.published_at;
        if (bili.cover_url && !item.cover_url) item.cover_url = bili.cover_url;
        const duration = bili.duration || (Date.now() - startTime);
        item._jina_status = (item._jina_status ? item._jina_status + " " : "") + `tikhub_bilibili_ok_${duration}ms_bvid:${bili.bvid}`;
        if (!item._fetcher) item._fetcher = "tikhub_bilibili";
        item._quality = "ok";
        console.log(`[TikHub-B站] ✅ ${duration}ms bvid=${bili.bvid} view=${bili.view_count}`);
        // 不早退 —— TikHub 只补字段，接下来继续走 Firecrawl 如果还没 text
      } else {
        console.log(`[TikHub-B站] ❌ ${bili.error}，降级到 Firecrawl`);
        item._jina_status = `tikhub_bilibili_fail:${bili.error}`;
        // 继续走 Firecrawl 兜底
      }
    } catch (err) {
      console.error("[TikHub-B站] 异常:", err.message);
      item._jina_status = `tikhub_bilibili_exception:${err.message}`;
    }
  }

  // 🆕 优先用 Firecrawl（反爬能力更强），失败降级到 Jina Reader
  let markdown = "";
  let fetchStatus = "";
  let fetcher = "";

  const startTime = Date.now();

  // ==================== 第 1 优先级：Firecrawl ====================
  if (env.FIRECRAWL_API_KEY) {
    try {
      const fc = await fetchFromFirecrawl(url, env);
      if (fc.ok && fc.markdown && fc.markdown.length > 100) {
        markdown = fc.markdown;
        fetchStatus = `firecrawl_ok_len${markdown.length}_${fc.duration}ms_proxy:${fc.proxyUsed || "?"}`;
        fetcher = "firecrawl";
        console.log(`[Firecrawl] ✅ 抓取成功: ${markdown.length}字符 (${fc.duration}ms, proxy=${fc.proxyUsed})`);
        // 🆕 顺手拿 title：iOS 场景 item.title 可能就是 URL，也要覆盖
        // 判定规则：Firecrawl 有 title，且当前 item.title 是空/URL/太短
        const currTitle = String(item.title || "").trim();
        const titleIsUrl = /^https?:\/\//i.test(currTitle);
        if (fc.title && (!currTitle || titleIsUrl || currTitle.length < 5)) {
          item.title = fc.title;
        }
      } else {
        fetchStatus = `firecrawl_fail:${fc.error || "empty"}`;
        console.log(`[Firecrawl] ❌ 失败: ${fc.error || "empty"}，降级到 Jina`);
      }
    } catch (err) {
      fetchStatus = `firecrawl_exception:${err.message}`;
      console.error("[Firecrawl] 异常:", err.message);
    }
  } else {
    console.log("[Firecrawl] 未配置 API Key，跳过，直接用 Jina");
  }

  // ==================== 第 2 优先级：Jina Reader 降级 ====================
  if (!markdown || markdown.length < 100) {
    const jinaResult = await fetchFromJina(url, env);
    if (jinaResult.markdown && jinaResult.markdown.length > 100) {
      markdown = jinaResult.markdown;
      fetchStatus = (fetchStatus ? fetchStatus + " | " : "") + jinaResult.status;
      fetcher = "jina";
      if (jinaResult.title && (!item.title || item.title === url || item.title.length < 5)) {
        item.title = jinaResult.title;
      }
    } else {
      fetchStatus = (fetchStatus ? fetchStatus + " | " : "") + (jinaResult.status || "jina_empty");
    }
  }

  const totalDuration = Date.now() - startTime;
  item._jina_status = fetchStatus; // 保持字段名兼容监控台，实际是"fetch_status"
  item._fetcher = fetcher;

  if (!markdown || markdown.length < 100) {
    console.log(`[Fetch] ❌ 全部抓取失败 (${totalDuration}ms)`);
    item._quality = "fetch_failed";
    return;
  }

  // 替换 text（先做知乎问答页正文截断，避免"更多回答"污染）
  // 注意：先只做"尾部截断"（拿到 with author 的 markdown 用来挖元数据），
  //       然后再做"头部裁剪"（送给 Coze 时才砍掉页面壳，避免 Coze 误解为综述整个问题）
  const trimmedForMeta = trimZhihuMainAnswer(markdown, url, { headCut: false });
  item.text = trimmedForMeta;

  // 🆕 iOS/Shortcut 场景：如果 item.author / published_at 是空（客户端没抓），
  // 尝试从抓到的 markdown 里挖一遍（服务端兜底补元数据）
  if (!item.author || !item.published_at) {
    const extracted = extractMetaFromMarkdown(item.text, url);  // 用截断后的干净 md（带 author 链接）
    if (!item.author && extracted.author) {
      item.author = extracted.author;
      console.log(`[Fetch] 从 markdown 挖到 author: ${extracted.author}`);
    }
    if (!item.published_at && extracted.published_at) {
      item.published_at = extracted.published_at;
      console.log(`[Fetch] 从 markdown 挖到 published_at: ${extracted.published_at}`);
    }
  }

  // 挖完元数据后，再把头部页面壳（问题描述/关注者/查看全部N个回答/作者头衔行）砍掉，
  // 送给 Coze 的 text 只保留主回答正文
  item.text = trimZhihuMainAnswer(item.text, url, { headCut: true, tailCut: false });
  // 🆕 再把 markdown 语法剥掉（图片/链接/加粗/标题符号/分隔线/评论区），Coze 拿到纯正文
  item.text = cleanMarkdownForCoze(item.text, url);

  // ==================== blocked 检测 + Wayback 兜底 ====================
  const blocked = detectBlockedPage(item.text);
  if (blocked) {
    console.log(`[Fetch] ⚠️ 检测到 blocked（原因：${blocked}, 抓手：${fetcher}），尝试 Wayback 兜底`);
    item._jina_status += `_blocked:${blocked}`;
    const wayback = await fetchFromWayback(url);
    if (wayback && wayback.text && wayback.text.length > 500) {
      console.log(`[Wayback] ✅ 兜底成功: ${wayback.text.length}字符 (归档时间: ${wayback.snapshot_time})`);
      item.text = wayback.text;
      item._wayback_status = `ok_len${wayback.text.length}_${wayback.snapshot_time}`;
      item._quality = "wayback_recovered";
    } else {
      console.log("[Wayback] ❌ 兜底失败，标记 blocked 供后续人工处理");
      item._wayback_status = "no_snapshot";
      item._quality = "blocked";
    }
  } else {
    item._quality = "ok";
  }
}

// ========== 🎬 TikHub · B站视频结构化抓取 ==========
// 命中 bilibili.com / b23.tv 时优先走 TikHub 官方 API 化接口
// 免费额度覆盖，不消耗 Firecrawl credit
// 返回：{ ok, title, author, published_at, cover_url, view_count, duration_sec,
//        bvid, aid, canonical_url, markdown, error, duration }
async function fetchFromTikhubBilibili(url, env) {
  const start = Date.now();
  if (!env.TIKHUB_API_KEY) {
    return { ok: false, error: "TIKHUB_API_KEY missing" };
  }
  try {
    // b23.tv 短链先 302 拿真链（TikHub 也支持短链，但 explicit 更稳）
    let target = url;
    if (/(^|\/\/)b23\.tv\//i.test(url)) {
      try {
        const r = await fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const loc = r.headers.get("location");
        if (loc) target = loc;
      } catch (e) {
        console.log("[TikHub-B站] 短链解析失败:", e.message);
      }
    }

    const api = "https://api.tikhub.io/api/v1/bilibili/web/fetch_one_video_v3?url=" +
      encodeURIComponent(target);
    const resp = await fetch(api, {
      headers: { Authorization: `Bearer ${env.TIKHUB_API_KEY}` },
    });
    const duration = Date.now() - start;
    if (!resp.ok) {
      return { ok: false, error: `tikhub_http_${resp.status}`, duration };
    }
    const body = await resp.json();
    if (body.code !== 200) {
      return { ok: false, error: `tikhub_code_${body.code}:${body.message_zh || body.message || "?"}`.slice(0, 200), duration };
    }
    const d = body.data || {};
    if (!d.title && !d.bvid) {
      return { ok: false, error: "tikhub_empty_data", duration };
    }

    // 组装成现有 pipeline 期望的 markdown（喂 Coze 用）
    const mdLines = [
      `# ${d.title || ""}`,
      "",
      `**作者**：${d.owner?.name || "(未知)"}`,
      `**发布**：${d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : "?"}`,
      `**时长**：${d.duration ? `${Math.floor(d.duration / 60)}分${d.duration % 60}秒` : "?"}`,
      `**播放**：${d.stat?.view ?? "?"}`,
      `**分区**：${d.tname || d.tname_v2 || ""}`,
      "",
      "## 视频简介",
      "",
      d.desc || "(UP 主未填写简介)",
    ];
    const markdown = mdLines.join("\n");

    return {
      ok: true,
      title: d.title || "",
      author: d.owner?.name || "",
      published_at: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : "",
      cover_url: d.pic || "",
      view_count: d.stat?.view,
      duration_sec: d.duration,
      bvid: d.bvid || "",
      aid: d.aid || "",
      canonical_url: d.bvid ? `https://www.bilibili.com/video/${d.bvid}` : target,
      markdown,
      duration,
    };
  } catch (err) {
    return { ok: false, error: `tikhub_exception:${err.message}`, duration: Date.now() - start };
  }
}

// 🆕 Firecrawl 抓取封装
// 返回 { ok, markdown, title, error, duration, proxyUsed }
async function fetchFromFirecrawl(url, env) {
  const start = Date.now();
  try {
    const body = {
      url,
      formats: ["markdown"],
      // proxy=auto: 先试便宜的 basic (1 credit)，失败自动升级 enhanced (5 credits)
      proxy: "auto",
      // 🆕 强制桌面浏览器 UA（避免知乎/微信触发"打开 App / 用 Safari 打开"移动落地页）
      mobile: false,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      // ⚠️ 不设 location.country：Firecrawl 无中国出口，设 CN 会 ERR_TUNNEL_ 崩掉；默认 US 反而能抓大多数中文站
      // 只等到 DOMContentLoaded 就够（速度快），复杂 SPA 可以调大
      waitFor: 2000,
      // 移除广告/侧栏等噪音
      onlyMainContent: true,
      blockAds: true,
      // 🆕 只用最保守的通用 excludeTags；知乎侧的"更多回答"由服务端 trimZhihuMainAnswer 做兜底
      // 教训：过于激进的 CSS 选择器（如 .Question-mainColumn > .List:not(:first-child)）会误伤主回答
      excludeTags: [
        "aside",
        "footer",
        "nav",
        ".sidebar",
      ],
      // 超时保护（毫秒），CF Worker 单请求最长 30s，这里留余量
      timeout: 25000,
    };
    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const duration = Date.now() - start;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP${resp.status}:${errText.slice(0, 120)}`, duration };
    }
    const data = await resp.json();
    // Firecrawl v2 响应形如 { success: true, data: { markdown, metadata: { title, ...}, warning } }
    // 兼容 v1 老结构 { success, data: { markdown, metadata } }
    if (!data.success) {
      return { ok: false, error: data.error || "no_success", duration };
    }
    const doc = data.data || data;
    const md = doc.markdown || "";
    const title = doc.metadata?.title || doc.metadata?.ogTitle || "";
    // proxy 用了哪种：v2 会在 warning 里提示
    const proxyUsed = doc.warning?.includes?.("enhanced") ? "enhanced" : "basic";
    return { ok: true, markdown: md, title, duration, proxyUsed };
  } catch (err) {
    return { ok: false, error: err.message, duration: Date.now() - start };
  }
}

// 🆕 Jina Reader 抓取封装（原逻辑抽出，供降级使用）
// 返回 { markdown, title, status }
async function fetchFromJina(url, env) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  console.log("[Jina] 开始抓取:", jinaUrl);
  const start = Date.now();
  try {
    const headers = {
      "Accept": "text/plain",
      "X-Return-Format": "markdown",
      "X-Engine": "browser",
      "X-With-Generated-Alt": "true",
    };
    if (env.JINA_API_KEY) {
      headers["Authorization"] = `Bearer ${env.JINA_API_KEY}`;
    }
    const resp = await fetch(jinaUrl, { headers });
    const duration = Date.now() - start;
    if (!resp.ok) {
      return { markdown: "", title: "", status: `jina_fail_http${resp.status}_${duration}ms` };
    }
    const markdown = await resp.text();
    let title = "";
    const m = markdown.match(/^#\s+(.+?)(?:\n|$)/m) || markdown.match(/^Title:\s*(.+?)(?:\n|$)/im);
    if (m && m[1]) title = m[1].trim();
    return {
      markdown,
      title,
      status: `jina_ok_${resp.status}_len${markdown.length}_${duration}ms`,
    };
  } catch (err) {
    return { markdown: "", title: "", status: `jina_exception:${err.message}` };
  }
}

// 🆕 检测页面是否是登录墙/验证页/反爬拦截页
// 返回：命中原因字符串（含关键词的截断片段），未命中返回 null
function detectBlockedPage(text) {
  if (!text) return null;
  // 只看前 1500 字符（拦截页通常前几百字就暴露）
  const head = text.slice(0, 1500).toLowerCase();
  const totalLen = text.length;

  // ⚠️ CAPTCHA / 验证码 / 环境异常 这些关键词，很多正常文章正文里也会出现（讲反爬技术、AI 安全等）
  //    只有当文章很短（< 3000 字）且前段命中拦截关键词时，才判为 blocked
  //    如果文章已经很长（> 3000 字），主回答几乎肯定已经在里面了，不管拦截关键词
  const SHORT_LIMIT = 3000;

  // 强特征：无论文章多长都算 blocked（这些是明确的拦截页文案，不会出现在正常文章里）
  const hardPatterns = [
    { kw: ["环境异常，完成验证后即可继续访问", "去验证", "拖动滑块完成拼图", "拖动下方滑块"], reason: "captcha" },
    { kw: ["安全验证", "系统检测到您的操作"], reason: "verification" },
    { kw: ["请登录后查看", "please log in to continue", "login required to view", "登录 · 知乎"], reason: "login_wall" },
    { kw: ["access denied", "403 forbidden", "you don't have permission"], reason: "forbidden" },
    { kw: ["页面不存在", "已被删除", "内容不存在", "参数错误", "parameter error", "temporarily unable to visit", "该页面无法访问"], reason: "not_found" },
    { kw: ["ip 已被限制", "访问过于频繁", "rate limit", "too many requests"], reason: "rate_limited" },
    { kw: ["选择在safari中打开", "在safari中打开", "点击右上角", "立即打开/下载", "下载「知乎」客户端", "正在打开知乎", "使用浏览器打开", "open in app"], reason: "app_wall" },
  ];
  for (const p of hardPatterns) {
    for (const k of p.kw) {
      if (head.includes(k.toLowerCase())) return `${p.reason}:${k}`;
    }
  }

  // 弱特征：泛用词汇（captcha / 需要登录 / 完成验证），只有短页面才判 blocked
  if (totalLen < SHORT_LIMIT) {
    const softPatterns = [
      { kw: ["captcha", "please make sure you are authorized", "requiring captcha"], reason: "captcha" },
      { kw: ["需要登录", "登录后查看", "please log in", "login required"], reason: "login_wall" },
      { kw: ["完成验证后", "验证滑块"], reason: "verification" },
    ];
    for (const p of softPatterns) {
      for (const k of p.kw) {
        if (head.includes(k.toLowerCase())) return `${p.reason}:${k}(short)`;
      }
    }
  }

  // 极短文本 + 任何拦截关键词
  if (totalLen < 500 && /(验证|登录|访问权限|parameter error)/i.test(head)) {
    return "short_with_blocked_keyword";
  }
  return null;
}

// 🆕 Wayback Machine 兜底：查询归档快照，抓最新一版的纯文本
async function fetchFromWayback(url) {
  try {
    // 1. 查最新可用快照
    const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const availResp = await fetch(availabilityUrl, {
      headers: { "User-Agent": "kb.dongjun.tech/1.0" },
    });
    if (!availResp.ok) {
      console.log("[Wayback] availability API 失败:", availResp.status);
      return null;
    }
    const availJson = await availResp.json();
    const snapshot = availJson?.archived_snapshots?.closest;
    if (!snapshot || !snapshot.available || !snapshot.url) {
      console.log("[Wayback] 该 URL 无归档快照");
      return null;
    }
    // 2. 取归档快照 → 再喂给 Jina Reader 转 Markdown（Wayback 返回带工具栏的原始 HTML）
    // 用 id_ 后缀能拿到无工具栏的原页面
    const rawSnapUrl = snapshot.url.replace(/\/(\d+)\//, "/$1id_/");
    console.log("[Wayback] 找到快照:", rawSnapUrl);
    const jinaWayback = `https://r.jina.ai/${rawSnapUrl}`;
    const resp = await fetch(jinaWayback, {
      headers: { "Accept": "text/plain", "X-Return-Format": "markdown" },
    });
    if (!resp.ok) {
      console.log("[Wayback→Jina] 失败:", resp.status);
      return null;
    }
    const markdown = await resp.text();
    if (markdown.length < 500) return null;
    // Wayback 归档页可能还是命中原登录墙的（老快照就是那样），二次检测
    if (detectBlockedPage(markdown)) {
      console.log("[Wayback] 归档快照本身也是拦截页，放弃");
      return null;
    }
    return {
      text: markdown,
      snapshot_time: snapshot.timestamp,
      snapshot_url: rawSnapUrl,
    };
  } catch (e) {
    console.error("[Wayback] 异常:", e.message);
    return null;
  }
}

export async function enrichWithCoze(item, env = {}) {
  if (!env.COZE_API_KEY || !env.COZE_WORKFLOW_ID) {
    console.log("[Coze] 跳过Coze调用，缺少API Key或Workflow ID");
    return fallbackEnrich(item);
  }

  const startTime = Date.now();
  // ✅ 只传Coze工作流真正需要的3个字段：AI分析用title+text，IF选择器用source_platform路由
  // 其他字段（source_url、canonical_url、id、capture_device等）由Worker自己管理，不进Coze
  const cozeInput = {
    title: item.title,
    text: item.text,
    source_platform: item.source_platform,
  };

  try {
    const resp = await fetch(`${env.COZE_BASE_URL || "https://api.coze.com"}/v1/workflow/run`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.COZE_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflow_id: env.COZE_WORKFLOW_ID,
        parameters: cozeInput,
      }),
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      const errorResult = { ...fallbackEnrich(item), coze_status: "failed", coze_error: bodyText.slice(0, 500) };
      errorResult.debug_coze_input = cozeInput;
      console.error("[Coze] 请求失败，状态码:", resp.status);
      return errorResult;
    }

    const body = parseMaybeJson(bodyText);
    const data = extractCozeOutput(body);

    const result = mergeEnrichment(item, data, "ok");

    // 🆕 把 enriched 里的 author / published_at 也回填到 result（存 D1 供监控台查看）
    result.debug_final_author = result.author;
    result.debug_final_published_at = result.published_at;

    // ✅ 把调试信息放在result里，接口会直接返回
    result.debug_coze_input = cozeInput;
    result.debug_coze_parsed = data;
    result.debug_coze_raw_body = body;  // 🔍 Coze API返回的原始结构，用来诊断解析问题

    console.log("[Coze] 处理完成，分类:", data.category, "置信度:", data.confidence, "标签数:", data.tags?.length || 0);

    return result;
  } catch (error) {
    const errorResult = { ...fallbackEnrich(item), coze_status: "failed", coze_error: error.message };
    errorResult.debug_coze_input = cozeInput;
    console.error("[Coze] 调用异常:", error.name, error.message);
    return errorResult;
  }
}

export function fallbackEnrich(item) {
  const summarySource = item.text || item.title || item.source_url;
  const summary = summarySource.length > 260 ? `${summarySource.slice(0, 257)}...` : summarySource;
  const tags = Array.from(new Set([
    ...keywordTags(`${item.title} ${item.text}`),
  ].filter(Boolean))).slice(0, 8);

  return {
    ...item,
    summary: summary || "待补充摘要",
    key_points: buildFallbackKeyPoints(item, summary),
    tags,
    category: guessCategory(`${item.title} ${item.text}`),
    author: "",
    published_at: "",
    entities: keywordEntities(`${item.title} ${item.text}`),
    importance: 3,
    confidence: item.text ? "中" : "低",
    basis: item.text
      ? "基于标题和已提供文本生成，未获取完整上下文。"
      : "仅基于标题或链接生成，信息不足，需回源确认。",
    coze_status: "skipped",
  };
}

function mergeEnrichment(item, data = {}, cozeStatus) {
  const fallback = fallbackEnrich(item);
  const keyPoints = data.key_points || data.keyPoints || fallback.key_points;
  const basis = data.basis || data.limitations || data.input_basis || fallback.basis;
  return {
    ...fallback,
    ...data,
    id: item.id,
    source_url: item.source_url,
    canonical_url: item.canonical_url,
    captured_at: item.captured_at,
    // ✅ published_at 从用户输入透传（Coze不生成这个字段，由插件端解析平台原始时间）
    // Coze data 也可能返回 published_at（比如从正文里解析出来的），如果Coze有值就优先用Coze的
    published_at: stringOrEmpty(data.published_at || item.published_at),
    // ✅ author 优先用插件抓取的（平台原始真值），Coze生成的作兜底（万一插件没抓到）
    author: stringOrEmpty(item.author || data.author),
    // ✅ title 优先用插件/Firecrawl 抓到的原始页面标题，Coze 生成的作兜底
    //    否则 Coze 会自己起个抽象总结型标题（如"XX解析"），偏离原文
    title: stringOrEmpty(item.title).trim() || stringOrEmpty(data.title).trim() || fallback.title,
    summary: stringOrEmpty(data.summary).trim() || fallback.summary,
    tags: normalizeTags(data.tags || fallback.tags),
    key_points: normalizeKeyPoints(keyPoints),
    entities: normalizeEntities(data.entities || fallback.entities),
    importance: normalizeImportance(data.importance ?? fallback.importance),
    confidence: normalizeConfidence(data.confidence || fallback.confidence),
    basis: stringOrEmpty(basis).trim(),
    category: stringOrEmpty(data.category || fallback.category),
    source_platform: stringOrEmpty(data.source_platform || item.source_platform),
    content_type: stringOrEmpty(data.content_type || item.content_type),
    coze_status: cozeStatus,
  };
}

export async function createNotionPage(item, env = {}) {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) {
    return { status: "skipped", reason: "missing NOTION_API_KEY or NOTION_DATABASE_ID" };
  }

  const properties = {
    Title: titleProp(item.title),
    Summary: richTextProp(item.summary),
    "Key Points": richTextProp(formatKeyPoints(item.key_points)),
    Category: selectProp(item.category),
    Tags: multiSelectProp(item.tags),
    Entities: richTextProp(normalizeEntities(item.entities)),
    "Source URL": urlProp(item.source_url),
    "Source Platform": selectProp(item.source_platform),
    "Content Type": selectProp(item.content_type),
    "Captured At": dateProp(item.captured_at),
    "Published At": item.published_at ? dateProp(item.published_at) : undefined,
    Author: richTextProp(item.author || ""),
    Importance: numberProp(item.importance),
    Confidence: selectProp(item.confidence),
    Basis: richTextProp(item.basis || ""),
    Privacy: selectProp(item.privacy),
    "Vector Status": selectProp("pending"),
  };

  Object.keys(properties).forEach((key) => properties[key] === undefined && delete properties[key]);

  const markdownText = buildPlainTextForRag(item);
  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NOTION_API_KEY}`,
      "content-type": "application/json",
      "notion-version": env.NOTION_VERSION || "2022-06-28",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
      children: notionChildren(item, markdownText),
    }),
  });

  const body = await safeJson(resp);
  if (!resp.ok) {
    const message = body?.message || JSON.stringify(body).slice(0, 500);
    console.log("notion_create_failed", JSON.stringify({ status: resp.status, message, code: body?.code }));
    const result = { status: "failed", error: message };
    if (item.debug_info) item.debug_info.phase4_notionResult = result;
    return result;
  }

  const result = { status: "created", page_id: body.id, url: body.url };
  if (item.debug_info) item.debug_info.phase4_notionResult = result;
  return result;
}

export async function indexDify(item, notion, env = {}) {
  if (!env.DIFY_API_KEY || !env.DIFY_DATASET_ID) {
    return { status: "skipped", reason: "missing DIFY_API_KEY or DIFY_DATASET_ID" };
  }

  const baseUrl = env.DIFY_BASE_URL || "https://api.dify.ai";
  const text = buildPlainTextForRag(item, notion);
  const resp = await fetch(`${baseUrl}/v1/datasets/${env.DIFY_DATASET_ID}/document/create_by_text`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DIFY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: item.title,
      text,
      indexing_technique: "high_quality",
      process_rule: { mode: "automatic" },
    }),
  });

  const body = await safeJson(resp);
  if (!resp.ok) {
    return { status: "failed", error: body?.message || JSON.stringify(body).slice(0, 500) };
  }

  return { status: "indexed", document_id: body.document?.id || body.id || null };
}

export async function retrieveDify(query, topK, env = {}) {
  if (!env.DIFY_API_KEY || !env.DIFY_DATASET_ID) {
    return { source: "dify_skipped", results: [] };
  }

  const baseUrl = env.DIFY_BASE_URL || "https://api.dify.ai";
  const resp = await fetch(`${baseUrl}/v1/datasets/${env.DIFY_DATASET_ID}/retrieve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DIFY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      retrieval_model: {
        search_method: "semantic_search",
        reranking_enable: false,
        top_k: topK,
        score_threshold_enabled: false,
      },
    }),
  });

  const body = await safeJson(resp);
  if (!resp.ok) {
    return { source: "dify_failed", results: [], error: body?.message || JSON.stringify(body).slice(0, 500) };
  }

  const records = body.records || body.data || [];
  return {
    source: "dify",
    results: records.slice(0, topK).map((record) => {
      const segment = record.segment || record;
      const metadata = segment.metadata || record.metadata || {};
      return {
        id: segment.document_id || segment.id || record.id || null,
        title: segment.document?.name || metadata.title || segment.title || "未命名知识",
        summary: metadata.summary || "",
        snippet: segment.content || record.content || "",
        tags: normalizeTags(metadata.tags || []),
        source_url: metadata.source_url || "",
        notion_page_url: metadata.notion_page_url || "",
        score: record.score ?? segment.score ?? null,
      };
    }),
  };
}

function authorize(request, env) {
  // 临时跳过Token校验，先跑通流程
  return { ok: true };
  
  if (!env.INGEST_TOKEN) return { ok: true };
  const auth = request.headers.get("authorization") || "";
  const apiKey = request.headers.get("x-api-key") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : apiKey;
  if (token === env.INGEST_TOKEN) return { ok: true };
  return { ok: false, error: "unauthorized" };
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,x-api-key");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function detectPlatform(url) {
  if (!url) return "manual";
  const host = safeUrl(url)?.hostname || "";
  if (host.includes("zhihu.com")) return "知乎";
  if (host.includes("bilibili.com") || host.includes("b23.tv")) return "B站";
  if (host.includes("weixin.qq.com") || host.includes("mp.weixin.qq.com")) return "微信公众号";
  if (host.includes("xiaohongshu.com") || host.includes("xhslink.com")) return "小红书";
  if (host.includes("douyin.com") || host.includes("iesdouyin.com")) return "抖音";
  if (host.includes("weishi") || host.includes("channels.weixin")) return "视频号";
  return "网页";
}

function inferContentType(input, url) {
  if (input.file_url) return fileType(input.file_url);
  if (input.images?.length) return "image";
  const lower = String(url || "").toLowerCase();
  if (/(bilibili|douyin|video|youtube|youtu\.be)/.test(lower)) return "video";
  return fileType(lower) || "article";
}

function fileType(url) {
  if (/\.pdf(\?|$)/i.test(url)) return "pdf";
  if (/\.(doc|docx)(\?|$)/i.test(url)) return "doc";
  if (/\.(ppt|pptx)(\?|$)/i.test(url)) return "ppt";
  if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(url)) return "image";
  return "";
}

function canonicalizeUrl(url) {
  const u = safeUrl(url);
  if (!u) return "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm"].forEach((key) => u.searchParams.delete(key));
  u.hash = "";
  return u.toString();
}

function safeUrl(url) {
  try { return new URL(url); } catch { return null; }
}

function guessTitle(text, url) {
  const firstLine = String(text || "").split(/\n+/).map((s) => s.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 80);
  const u = safeUrl(url);
  return u?.hostname || "未命名知识";
}

function guessCategory(text) {
  const t = text.toLowerCase();
  if (/(ai|agent|rag|大模型|模型|提示词|coze|dify|cursor|codex|copilot|模型训练|模型推理|ai infra)/i.test(t)) return "AI技术";
  if (/(云|虚拟化|容器|kubernetes|k8s|分布式存储|网络架构)/i.test(t)) return "云计算与基础设施";
  if (/(代码|软件|架构|接口|api|devops|ci\/cd|开发范式|tdd|ddd)/i.test(t)) return "软件工程";
  if (/(数据库|大数据|数据治理|数据分析|安全|隐私|身份权限)/i.test(t)) return "数据与安全";
  if (/(制造业|供应链|港口|汽车|消费电子|信创|行业趋势|企业数字化|招商局|富士康|比亚迪|影石)/.test(text)) return "行业研究";
  if (/(销售|商机|项目|报价|跟进|产品策略|客户需求|商业模式|竞品|roi)/i.test(t)) return "商业与管理";
  if (/(知识管理|办公自动化|工作流|信息检索|写作表达)/.test(text)) return "效率工具";
  if (/(学习方法|思维模型|职业发展|成长)/.test(text)) return "个人成长";
  if (/(股票|房价|投资|利率|汇率|国际局势|宏观|政策|资本市场|历史)/.test(text)) return "宏观与社会";
  return "其他";
}

function keywordTags(text) {
  const tags = [];
  const map = [
    ["AI Agent", /(agent|智能体)/i],
    ["RAG", /rag|检索增强/i],
    ["大模型", /大模型|llm/i],
    ["企业知识库", /知识库|knowledge base/i],
    ["AI Coding", /ai coding|coding agent|codex|cursor|claude code|copilot/i],
    ["RAG", /coze|dify|notion/i],
    ["客户需求", /客户|招商局|富士康|比亚迪|影石/],
  ];
  for (const [tag, re] of map) if (re.test(text)) tags.push(tag);
  return tags;
}

function keywordEntities(text) {
  const entities = [];
  const map = [
    ["Coze", /coze|扣子/i],
    ["Dify", /dify/i],
    ["Notion", /notion/i],
    ["Cloudflare Worker", /cloudflare|worker/i],
    ["TDD", /\btdd\b|测试驱动/i],
    ["Harness", /harness/i],
    ["Kubernetes", /kubernetes|\bk8s\b/i],
    ["OpenAI", /openai/i],
    ["DeepSeek", /deepseek|深度求索/i],
    ["富士康", /富士康/],
    ["比亚迪", /比亚迪/],
    ["招商局", /招商局/],
    ["影石", /影石/],
  ];
  for (const [entity, re] of map) if (re.test(text)) entities.push(entity);
  return entities.join(", ");
}

function normalizeTags(tags) {
  if (typeof tags === "string") tags = tags.split(/[,，;；\n]+/);
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((x) => String(x).trim()).filter(Boolean))).slice(0, 12);
}

function normalizeKeyPoints(points) {
  if (Array.isArray(points)) return points.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  if (typeof points === "string") {
    return points
      .split(/\n+/)
      .map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  return [];
}

function buildFallbackKeyPoints(item, summary = "") {
  const text = `${item.title || ""} ${item.text || ""}`;
  const tags = keywordTags(text);
  const points = [];

  if (tags.some((tag) => ["AI Agent", "RAG", "企业知识库", "AI工作流", "AI Coding", "个人知识管理"].includes(tag))) {
    points.push("这条内容适合沉淀到个人知识库或 AI 工作流中，后续可用于检索、复用和方案参考。");
  }
  if (text.includes("Cloudflare Worker") || text.includes("Worker") || text.includes("插件") || text.includes("快捷指令") || text.includes("iPhone") || text.includes("Chrome")) {
    points.push("多端收录链路的关键价值在于降低记录阻力，并用统一入口减少后续系统对接复杂度。");
  }
  if (text.includes("Notion") || text.includes("Coze") || text.includes("Dify") || text.includes("RAG")) {
    points.push("把结构化存储、摘要分类和后续 RAG 检索拆层设计，有利于先跑通收录闭环再逐步增强能力。");
  }
  if (!points.length && summary) {
    points.push("这条内容值得作为后续回看线索，具体价值需要结合原文进一步判断。");
  }

  return Array.from(new Set(points)).slice(0, 3);
}

function formatKeyPoints(points) {
  return normalizeKeyPoints(points).map((point, index) => `${index + 1}. ${point}`).join("\n");
}

function normalizeEntities(entities) {
  if (Array.isArray(entities)) return entities.map(String).map((x) => x.trim()).filter(Boolean).join(", ");
  return stringOrEmpty(entities).trim();
}

function normalizeImportance(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function normalizeConfidence(value) {
  const v = stringOrEmpty(value).trim();
  return ["高", "中", "低"].includes(v) ? v : "中";
}

function extractCozeOutput(body = {}) {
  // Coze v1 workflow 输出是两层嵌套的JSON字符串：
  // body.data → 第一层JSON字符串 → data.output → 第二层JSON字符串 → 真正的结构化数据
  // 先把所有候选的字符串都解析成对象
  const candidates = [
    body?.data,
    body?.output,
    body?.result,
    // 特殊处理两层嵌套的情况：先解析 body.data，再解析里面的 .output
    parseMaybeJson(body?.data)?.output,
    parseMaybeJson(body?.data)?.result,
    parseMaybeJson(body?.data)?.content,
    body?.data?.output,
    body?.data?.result,
    body?.data?.content,
    body,
  ];
  for (const candidate of candidates) {
    const parsed = parseMaybeJson(candidate);
    if (parsed && typeof parsed === "object" && hasEnrichmentFields(parsed)) return parsed;
  }
  return {};
}

function hasEnrichmentFields(value) {
  return Boolean(value && typeof value === "object" && (
    value.title || value.summary || value.tags || value.category || value.key_points || value.keyPoints
  ));
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value || {};
  try { return JSON.parse(value); } catch { return { summary: value }; }
}

async function safeJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function titleProp(value) {
  return { title: [{ text: { content: truncate(value, 2000) } }] };
}

function richTextProp(value) {
  return { rich_text: [{ text: { content: truncate(value || "", 2000) } }] };
}

function numberProp(value) {
  const n = Number(value);
  return Number.isFinite(n) ? { number: n } : undefined;
}

function selectProp(value) {
  return value ? { select: { name: truncate(String(value), 100) } } : undefined;
}

function multiSelectProp(values) {
  return { multi_select: normalizeTags(values).map((name) => ({ name: truncate(name, 100) })) };
}

function urlProp(value) {
  return value ? { url: value } : undefined;
}

function dateProp(value) {
  const iso = normalizeDateToISO(value);
  return iso ? { date: { start: iso } } : undefined;
}

// 🆕 服务端最终 ISO 8601 兜底：无论客户端/Firecrawl/Coze 传什么形态的日期，
// 都在写入 Notion 前拦一遍。转不了返回 ""（→ dateProp 返回 undefined → Notion 不写这个字段）
function normalizeDateToISO(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // 去中英文前缀
  s = s.replace(/^(发布于|编辑于|发表于|Published on|Posted on|Updated on)\s*/i, "").trim();
  // 已经是完整 ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
  // 纯 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 2026-03-13 12:08(:00)
  let m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    const [_, y, mo, d, h, mi, se] = m;
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}:${String(se||"00").padStart(2,"0")}+08:00`;
  }
  // 2026年3月13日 12:08
  m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}T${String(m[4]).padStart(2,"0")}:${String(m[5]).padStart(2,"0")}:00+08:00`;
  // 2026年3月13日
  m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
  // 2026/03/13 或 2026-3-13
  m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
  // 兜底试 Date.parse
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return "";
}

// 🆕 从 Firecrawl 抓到的 markdown 里挖 author / published_at（iOS 兜底）
// 针对 3 个主要平台的 markdown 特征模式匹配
function extractMetaFromMarkdown(md, url = "") {
  const result = { author: "", published_at: "" };
  if (!md) return result;
  const host = (url.match(/^https?:\/\/([^\/]+)/) || [])[1] || "";

  // 直接调用截断（只做尾部，保留头部作者链接用于挖 author）
  let workingMd = md;
  if (host.includes("zhihu.com")) {
    workingMd = trimZhihuMainAnswer(md, url, { headCut: false });
  }
  return _extractMetaImpl(workingMd, host, result);
}

// 🆕 送给 Coze 之前把 markdown 语法剥掉：图片/链接/加粗/标题符号/分隔线/评论区
//    保留纯文字，让 Coze 输出与桌面端（Readability innerText）一致
function cleanMarkdownForCoze(text, url = "") {
  if (!text) return text;
  let out = String(text);

  // 1. 砍掉评论区（知乎/掘金常见）—— 在剥 markdown 前做，因为 marker 依赖零宽字符/加粗
  const commentMarkers = [
    /\n[^\n]{0,10}\d+\s*条评论\n?/,
    /\n默认\n最新\n/,
    /\n未登录用户\n/,
    /\n登录后你可以\n/,
    /\n[\u200b\u200c\u200d]?赞同\s*\d/,     // 知乎"​赞同 X"（前有零宽字符）
    /\n[\u200b\u200c\u200d]?分享\n/,        // 知乎"​分享"
    /\n[\u200b\u200c\u200d]?申请转载/,
  ];
  let commentCut = out.length;
  for (const re of commentMarkers) {
    const m = out.match(re);
    if (m && m.index !== undefined && m.index < commentCut) commentCut = m.index;
  }
  if (commentCut < out.length) out = out.slice(0, commentCut);

  // 2. 剥 markdown 语法
  out = out.replace(/!\[[^\]]*\]\([^\)]*\)/g, "");                   // 图片
  out = out.replace(/\[([^\]]+)\]\([^\)]*\)/g, "$1");                // 链接
  out = out.replace(/\*\*([^\*]+)\*\*/g, "$1");                      // 加粗
  out = out.replace(/__([^_]+)__/g, "$1");                           // 加粗
  out = out.replace(/^#{1,6}\s+/gm, "");                             // 标题符号
  out = out.replace(/^>\s+/gm, "");                                  // 引用符
  // 水平分隔线：`---` / `***` / `___` / `* * *`（可能有前后空格/换行）
  out = out.replace(/^[\s\u200b]*(?:[-*_][ \t]*){3,}[\s\u200b]*$/gm, "");
  out = out.replace(/\\([+\-*_`\[\]\(\)])/g, "$1");                  // 反斜杠转义
  out = out.replace(/[\u200b\u200c\u200d\ufeff]/g, "");              // 零宽字符

  // 3. 收敛空白
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.trim();

  return out;
}

// 🆕 知乎问答页 markdown 截断：只保留主回答部分，砍掉"更多回答/相关问题/关于作者"等尾部
// 用途：Coze payload text + 元数据挖掘，都要用这个干净版本
function trimZhihuMainAnswer(md, url = "", opts = {}) {
  if (!md) return md;
  const host = (url.match(/^https?:\/\/([^\/]+)/) || [])[1] || "";
  if (!host.includes("zhihu.com")) return md;
  const doHeadCut = opts.headCut !== false;
  const doTailCut = opts.tailCut !== false;
  let out = md;

  // ==== 尾部：砍掉"更多回答/关于作者/相关问题"等分隔符之后的内容 ====
  if (doTailCut) {
    const cutMarkers = [
      /####\s*更多回答/,
      /###\s*更多回答/,
      /##\s*更多回答/,
      /\n关于作者\n/,
      /\n\n关于作者\n/,
      /\n相关问题\n/,
      /\n大家都在搜\n/,
      /\n下载知乎客户端/,
      /扫码下载知乎/,
    ];
    let cutAt = out.length;
    const minCutPos = Math.floor(out.length * 0.3);
    for (const re of cutMarkers) {
      const m = out.match(re);
      if (m && m.index !== undefined && m.index >= minCutPos && m.index < cutAt) {
        cutAt = m.index;
      }
    }

    // 🆕 更可靠的分隔符：找所有出现的 /people/<slug>，找到第一个和主答主不同的 slug 位置
    //   注意：知乎作者链接可能是嵌套图片形式 [![即刻](img)](/people/xx)，普通括号正则匹配不到，
    //   所以直接扫描 URL 字符串本身
    const peopleUrlRegex = /https:\/\/www\.zhihu\.com\/people\/([^\)\?"\s]+)/g;
    const peopleUrlMatches = [...out.matchAll(peopleUrlRegex)];
    if (peopleUrlMatches.length >= 2) {
      const firstSlug = peopleUrlMatches[0][1];
      for (let i = 1; i < peopleUrlMatches.length; i++) {
        const slug = peopleUrlMatches[i][1];
        if (slug && slug !== firstSlug) {
          const nextAuthorPos = peopleUrlMatches[i].index;
          // 往前退到最近的换行/"阅读全文"，让截断更干净
          const beforeSlice = out.slice(0, nextAuthorPos);
          const readmoreIdx = beforeSlice.lastIndexOf("阅读全文");
          const moreAnswersIdx = beforeSlice.lastIndexOf("更多回答");
          const doubleNewlineIdx = beforeSlice.lastIndexOf("\n\n");
          // 优先"更多回答" > "阅读全文" > 最近的空行
          let candidateCut = -1;
          if (moreAnswersIdx > 0) candidateCut = moreAnswersIdx;
          else if (readmoreIdx > 0) candidateCut = readmoreIdx;
          else candidateCut = doubleNewlineIdx;
          if (candidateCut < 0 || candidateCut >= nextAuthorPos) candidateCut = nextAuthorPos;
          // 兜底不受 minCutPos 限制（因为 peopleUrl 分隔已经很确定）
          if (candidateCut < cutAt) cutAt = candidateCut;
          break;
        }
      }
    }

    if (cutAt < out.length) out = out.slice(0, cutAt);
  }

  // ==== 头部：砍掉"问题描述/关注者/查看全部 X 个回答/作者头衔"页面壳 ====
  if (doHeadCut) {
    const startMarkers = [
      /\[查看全部\s*\d+\s*个回答\][^\n]*\n+/,
      /\n关注问题[^\n]*写回答[^\n]*\n+/,
    ];
    let headCut = 0;
    for (const re of startMarkers) {
      const m = out.match(re);
      if (m && m.index !== undefined) {
        const cand = m.index + m[0].length;
        if (cand > headCut && cand < out.length * 0.5) headCut = cand;
      }
    }
    // 头部裁到第一个 /people/ 链接之后，再往后跳一行到正文
    const peopleAfterHead = out.slice(headCut).match(/\[[^\]]{2,30}\]\(https:\/\/www\.zhihu\.com\/people\/[^\)]+\)/);
    if (peopleAfterHead && peopleAfterHead.index !== undefined) {
      const afterAuthor = headCut + peopleAfterHead.index + peopleAfterHead[0].length;
      const rest = out.slice(afterAuthor);
      const paraMatch = rest.match(/\n\n([^\n]{15,})/);
      if (paraMatch && paraMatch.index !== undefined) {
        headCut = afterAuthor + paraMatch.index + 2;
      }
    }
    if (headCut > 0 && headCut < out.length * 0.5) {
      out = out.slice(headCut);
    }
  }
  return out;
}

function _extractMetaImpl(md, host, result) {
  // ---- 知乎 markdown 特征：
  //   问答页有 "答主 xxx" / "作者：xxx"，专栏有类似的
  //   时间通常是 "发布于 2026-06-09" 或 "编辑于 xxx" 或 "2026-06-09"
  if (host.includes("zhihu.com")) {
    // 作者：markdown 里 [作者名](https://www.zhihu.com/people/xxx) 是最稳的
    // 关键：只在 markdown 头部 4000 字符内找（评论区的评论者也用同样的链接格式，
    //       如果搜整个 md 会挖到第一个评论者，比如"郑LH"），
    //       主答主/专栏作者一定在正文开头。
    const headMd = md.slice(0, 4000);
    let authorFound = "";
    // 场景 1：普通链接 [名字](/people/xxx)
    const plainMatches = [...headMd.matchAll(/\[([^\]!][^\]]{1,25})\]\(https:\/\/www\.zhihu\.com\/people\/[^\)]+\)/g)];
    if (plainMatches.length > 0) {
      authorFound = plainMatches[0][1];
    } else {
      // 场景 2：嵌套图片格式 [![名字](img)](.../people/xxx) —— 取 alt 文本
      const imgMatches = [...headMd.matchAll(/\[!\[([^\]]{1,25})\]\([^)]+\)\]\(https:\/\/www\.zhihu\.com\/people\/[^\)]+\)/g)];
      if (imgMatches.length > 0) authorFound = imgMatches[0][1];
    }
    if (authorFound) {
      let a = authorFound.replace(/\s*(关注|Follow|已关注)\s*$/g, "").trim();
      const parts = a.split(/\s+/);
      if (parts.length > 1 && parts[0].length >= 2) a = parts[0];
      result.author = a;
    }
    // 🆕 发布时间：只信 "发布于/编辑于" 前缀，不做通用兜底
    const timeMatch = md.match(/(?:发布于|编辑于)\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2}[日]?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/);
    if (timeMatch) result.published_at = normalizeDateToISO(timeMatch[1]);
  }
  // ---- 微信 markdown 特征：
  else if (host.includes("mp.weixin.qq.com")) {
    // 作者：markdown 前几行常有"公众号名" or [公众号名](...)
    const wxAuthor = md.match(/\*\*([^*]+)\*\*[^\n]{0,50}公众号/) ||
                     md.match(/\[([^\]]+)\]\(https:\/\/mp\.weixin\.qq\.com\/mp\/profile/);
    if (wxAuthor) result.author = wxAuthor[1].trim();
    // 微信正文里"发布于/发表于"更可靠，先试；不行再宽泛匹配（微信页面里日期通常就一个）
    const wxTimeStrict = md.match(/(?:发表于|发布于)\s*(20\d{2}[-年\/]\d{1,2}[-月\/]\d{1,2}[日]?(?:\s+\d{1,2}:\d{1,2})?)/);
    if (wxTimeStrict) {
      result.published_at = normalizeDateToISO(wxTimeStrict[1]);
    } else {
      const wxTime = md.match(/(20\d{2}[-年\/]\d{1,2}[-月\/]\d{1,2}[日]?(?:\s+\d{1,2}:\d{1,2})?)/);
      if (wxTime) result.published_at = normalizeDateToISO(wxTime[1]);
    }
  }
  // ---- 掘金 markdown 特征
  else if (host.includes("juejin.cn")) {
    const jjAuthor = md.match(/\[([^\]]+)\]\(https:\/\/juejin\.cn\/user\/[^\)]+\)/);
    if (jjAuthor) result.author = jjAuthor[1].trim();
    const jjTime = md.match(/(20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}[^\s]*)?)/);
    if (jjTime) result.published_at = normalizeDateToISO(jjTime[1]);
  }
  // ❌ 通用兜底移除：容易挖错年份（比如页面里最早出现的 20xx 字符）
  // 宁可 published_at 为空，也不要挖错。已知：知乎问答页面 markdown 里
  // 「问题创建时间/评论时间/推荐位时间」都会污染通用正则。
  return result;
}

function notionChildren(item, ragText) {
  const blocks = [];
  // ✅ 正文保留摘要（可读性好）
  blocks.push(paragraph(`摘要：${item.summary || ""}`));
  // ✅ 正文保留关键要点（便于扫读）
  if (item.key_points?.length) {
    blocks.push(heading2("关键要点"));
    for (const point of item.key_points.slice(0, 8)) blocks.push(bulleted(point));
  }
  // ❌ 不再输出原链接段落：属性区 Source URL 可直接点击跳转，正文重复反而不方便
  // ✅ 检索文本：折叠块保留供未来RAG/向量检索用
  const raw = truncate(ragText, 1800);
  if (raw) {
    blocks.push(toggleBlock("🔍 检索文本（RAG 索引用，可折叠）", [paragraph(raw)]));
  }
  return blocks;
}

function toggleBlock(title, children = []) {
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: richTextArray(title),
      children,
    },
  };
}

function paragraph(content) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richTextArray(content) } };
}
function heading2(content) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: richTextArray(content) } };
}
function bulleted(content) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richTextArray(content) } };
}
function richTextArray(content) {
  return [{ type: "text", text: { content: truncate(String(content || ""), 2000) } }];
}

export function buildPlainTextForRag(item, notion = {}) {
  return [
    `标题：${item.title || ""}`,
    `摘要：${item.summary || ""}`,
    item.key_points?.length ? `要点：\n- ${item.key_points.join("\n- ")}` : "",
    `分类：${item.category || ""}`,
    `标签：${(item.tags || []).join("、")}`,
    item.entities ? `实体：${normalizeEntities(item.entities)}` : "",
    `来源：${item.source_platform || ""}`,
    `内容类型：${item.content_type || ""}`,
    item.importance ? `重要性：${item.importance}` : "",
    item.confidence ? `置信度：${item.confidence}` : "",
    item.basis ? `依据：${item.basis}` : "",
    `链接：${item.source_url || ""}`,
    notion.url ? `知识页：${notion.url}` : "",
    item.text ? `原始文本：\n${item.text}` : "",
  ].filter(Boolean).join("\n\n");
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max - 1) : s;
}

function numberFrom(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stringOrEmpty(value) {
  return value == null ? "" : String(value);
}

function cryptoRandomId() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
