import { extract as tikhubExtract, normalizeDocument as tikhubNormalize, detectPlatform as tikhubDetectPlatform, toMarkdown as tikhubToMarkdown } from "./extractor/index.js";
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
    else if (result.notion_status === "created") status = "ok";
    else if (result.notion_status === "error" || result.notion_status === "failed") status = "partial";
    else status = "ok";
  }

  return [
    now,
    requestId,
    rawInput?.source_url || result?.source_url || "",
    result.title || rawInput?.title || "",
    result?.source_platform || rawInput?.source_platform || "",
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
  async queue(batch, env) {
    for (const msg of batch.messages) {
      let requestId, input;
      try {
        ({ requestId, input } = JSON.parse(msg.body));
      } catch (e) {
        console.error("[queue] 消息体 JSON 解析失败:", e.message);
        continue;
      }
      const startedAt = Date.now();
      console.log(`[queue] 开始处理任务 ${requestId}`);
      await loadSecretsFromDB(env);

      try {
        const result = await ingest(input, env);
        const durationMs = Date.now() - startedAt;

        // D1 监控日志
        if (env.kb_logs) {
          const logRow = buildLogRow(requestId, input, result, durationMs);
          await env.kb_logs
            .prepare(`INSERT INTO ingest_logs (created_at, request_id, source_url, title, source_platform, capture_device, status, raw_payload, jina_status, jina_text_length, coze_input, coze_output, coze_error, notion_page_id, notion_page_url, notion_status, notion_error, duration_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(...logRow)
            .run()
            .catch((e) => console.error("[monitor] D1 写入失败:", e.message));

          // 更新 async_tasks 状态
          await env.kb_logs
            .prepare(`UPDATE async_tasks SET status = ?, result_json = ?, error = NULL WHERE id = ?`)
            .bind("done", JSON.stringify({ ok: result.ok, title: result.title, notion_url: result.notion_page_url }).slice(0, 4000), requestId)
            .run()
            .catch((e) => console.error("[monitor] D1 状态更新失败:", e.message));
        }

        // 📱 Bark 推送通知
        if (env.BARK_KEY) {
          await sendBarkNotification(env.BARK_KEY, result).catch((e) => console.error("[bark] 推送失败:", e.message));
        }

        console.log(`[queue] 任务 ${requestId} 完成 (${durationMs}ms)`);
        msg.ack();
      } catch (e) {
        console.error(`[queue] 任务 ${requestId} 失败: ${e.message}`);

        // 失败也推 Bark
        if (env.BARK_KEY) {
          await sendBarkNotification(env.BARK_KEY, {
            title: input.title || input.source_url || "未知",
            coze_status: "failed",
            notion_status: "failed",
            jina_status: "error",
            source_platform: "",
            category: "未知",
            ok: false,
          }).catch(() => {});
        }

        // 更新 async_tasks 状态
        if (env.kb_logs) {
          await env.kb_logs
            .prepare(`UPDATE async_tasks SET status = ?, error = ? WHERE id = ?`)
            .bind("failed", e.message, requestId)
            .run()
            .catch(() => {});
        }

        msg.ack(); // 即使失败也 ack，避免无限重试
      }
    }
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  // 每个请求从 D1 加载最新的 secrets（D1 优先于 wrangler secret）
  await loadSecretsFromDB(env);

  if (request.method === "OPTIONS") {
    const resp = new Response(null, { status: 204 });
    resp.headers.set("access-control-allow-origin", "*");
    resp.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
    resp.headers.set("access-control-allow-headers", "authorization,content-type,x-api-key");
    resp.headers.set("access-control-max-age", "86400");
    return resp;
  }

  try {
    // /health 和 /admin 页面不需要鉴权
    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(json({ ok: true, service: "knowledge-space-worker", time: new Date().toISOString() }));
    }

    // /ingest 外部收录接口：必须有 Authorization header
    if (url.pathname === "/ingest" && request.method === "POST") {
      const auth = authorize(request, env);
      if (!auth.ok) {
        return withCors(json({ ok: false, error: auth.error }, 401));
      }
    }

    // 以下都是管理后台 API，用 URL 参数 ?token=xxx 鉴权（各自在路由内校验）

      if (url.pathname === "/ingest" && request.method === "POST") {
        const input = await readJson(request);
        // 校验：必须至少提供 url/source_url 或 text 之一，空提交直接 400
        const hasUrl = typeof input?.source_url === "string" && input.source_url.trim()
          || typeof input?.url === "string" && input.url.trim();
        const hasText = typeof input?.text === "string" && input.text.trim();
        if (!hasUrl && !hasText) {
          return withCors(json({ ok: false, error: "缺少必要字段：请提供 source_url 或 text" }, 400));
        }
        // requestId 用 cryptoRandomId（有 fallback，不依赖环境是否有 WebCrypto）
        const requestId = `kb_${Date.now()}_${cryptoRandomId()}`;

        // 🖥️ Chrome 插件走同步模式：直接处理完再返回，插件弹系统通知
        // 📱 iOS 走异步队列模式：投递消息后立即返回 202，处理完推 Bark
        const syncMode = input.sync === true || input.capture_device === "chrome-extension";

        if (syncMode) {
          const startedAt = Date.now();
          try {
            const result = await ingest(input, env, requestId);
            const durationMs = Date.now() - startedAt;

            // 📝 同步模式也写 D1 日志（跟异步队列消费者一样）
            if (env.kb_logs) {
              try {
                const logRow = buildLogRow(requestId, input, result, durationMs);
                await env.kb_logs
                  .prepare(`INSERT INTO ingest_logs (created_at, request_id, source_url, title, source_platform, capture_device, status, raw_payload, jina_status, jina_text_length, coze_input, coze_output, coze_error, notion_page_id, notion_page_url, notion_status, notion_error, duration_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                  .bind(...logRow)
                  .run();
              } catch (e) {
                console.error("[sync] D1 日志写入失败:", e.message);
              }
            }

            return withCors(json({
              ok: true,
              async: false,
              request_id: requestId,
              duration_ms: durationMs,
              title: result.title || input.title || "",
              notion_page_url: result.notion_page_url || "",
            }));
          } catch (err) {
            // 📝 失败也记日志
            if (env.kb_logs) {
              try {
                const failResult = { ...input, coze_status: "failed", notion_status: "failed", error: err.message };
                const logRow = buildLogRow(requestId, input, failResult, Date.now() - startedAt);
                await env.kb_logs
                  .prepare(`INSERT INTO ingest_logs (created_at, request_id, source_url, title, source_platform, capture_device, status, raw_payload, jina_status, jina_text_length, coze_input, coze_output, coze_error, notion_page_id, notion_page_url, notion_status, notion_error, duration_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                  .bind(...logRow)
                  .run();
              } catch (e) {
                console.error("[sync] D1 失败日志写入失败:", e.message);
              }
            }
            return withCors(json({ ok: false, error: err.message || String(err) }, 500));
          }
        }

        // 🚀 Cloudflare Queues 异步模式：投递消息后立即返回
        // 若队列未绑定（本地测试/未配置），降级为同步处理，避免 500
        if (env.INGEST_QUEUE?.send) {
          await env.INGEST_QUEUE.send(JSON.stringify({ requestId, input }));

          // D1 记录任务状态（供 /status 查询）
          if (env.kb_logs) {
            const writeTask = env.kb_logs
              .prepare(`INSERT INTO async_tasks (id, created_at, status, source_url) VALUES (?,?,?,?)`)
              .bind(requestId, new Date().toISOString(), "processing", input.source_url || input.url || "")
              .run()
              .catch((e) => console.error("[queue] D1 状态写入失败:", e.message));
            if (ctx?.waitUntil) ctx.waitUntil(writeTask);
          }

          return withCors(json({
            ok: true,
            async: true,
            message: "已接收，处理完成后会推送通知",
            request_id: requestId,
          }, 202));
        }

        // 队列未绑定：降级同步处理
        const startedAt = Date.now();
        try {
          const result = await ingest(input, env, requestId);
          const durationMs = Date.now() - startedAt;
          if (env.kb_logs) {
            try {
              const logRow = buildLogRow(requestId, input, result, durationMs);
              await env.kb_logs
                .prepare(`INSERT INTO ingest_logs (created_at, request_id, source_url, title, source_platform, capture_device, status, raw_payload, jina_status, jina_text_length, coze_input, coze_output, coze_error, notion_page_id, notion_page_url, notion_status, notion_error, duration_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .bind(...logRow)
                .run();
            } catch (e) {
              console.error("[sync-fallback] D1 日志写入失败:", e.message);
            }
          }
          return withCors(json({
            ok: true,
            async: false,
            fallback: true,
            request_id: requestId,
            duration_ms: durationMs,
            title: result.title || input.title || "",
            notion_page_url: result.notion_page_url || "",
          }));
        } catch (err) {
          return withCors(json({ ok: false, error: err.message || String(err) }, 500));
        }
      }

      // 🆕 异步任务状态查询（保留，兼容已发出的任务）
      if (url.pathname.startsWith("/status/") && request.method === "GET") {
        const token = url.searchParams.get("token") || "";
        if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
          return withCors(json({ ok: false, error: "unauthorized" }, 401));
        }
        const taskId = url.pathname.replace("/status/", "");
        if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not configured" }, 500));
        const row = await env.kb_logs.prepare(`SELECT * FROM async_tasks WHERE id = ?`).bind(taskId).first();
        if (!row) return withCors(json({ ok: false, error: "task not found" }, 404));
        const elapsed = row.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
        return withCors(json({
          ok: true,
          id: row.id,
          status: row.status,
          elapsed_ms: elapsed,
          result: row.status === "done" && row.result_json ? (() => { try { return JSON.parse(row.result_json); } catch { return null; } })() : null,
          error: row.error || null,
        }));
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

    // POST /api/logs/clear -> 清空所有日志（ingest_logs + async_tasks）
    if (url.pathname === "/api/logs/clear" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not bound" }, 500));
      await env.kb_logs.prepare(`DELETE FROM ingest_logs`).run();
      await env.kb_logs.prepare(`DELETE FROM async_tasks`).run();
      return withCors(json({ ok: true, message: "所有日志已清空" }));
    }

    if (url.pathname === "/search" && request.method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      // 支持 URL token 或 Authorization/x-api-key header（便于程序化调用）
      const token = url.searchParams.get("token") || request.headers.get("x-api-key") || "";
      const auth = request.headers.get("authorization") || "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN && bearer !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const topK = numberFrom(url.searchParams.get("top_k"), numberFrom(env.DEFAULT_TOP_K, 5));
      if (!q) return withCors(json({ ok: false, error: "missing query param: q" }, 400));
      const result = await searchKnowledge(q, topK, env);
      return withCors(json(result));
    }

    // 🆕 测试抓取接口 -- KB监控台前端调用
    if (url.pathname === "/api/test-fetch" && request.method === "POST") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      // 加载 D1 中配置的 Key（和正式流程 /ingest 一致，测试页要能验证真实配置）
      await loadSecretsFromDB(env);
      const input = await readJson(request);
      // input: { url: string, force_fetcher?: string }
      // 从分享文案中提取纯 URL（和 extractor ui.js 的 extractUrl 逻辑一致）
      const rawSource = input.source_url || "";
      const urlMatch = rawSource.match(/https?:\/\/[^\s；;]+/i);
      if (urlMatch) {
        input.source_url = urlMatch[0].replace(/[。，、!！?？~～]+$/g, "");
      }
      const normalized = normalizeIngestPayload({
        source_url: input.source_url,
        text: input.source_url, // iOS 场景：text 就是 url，触发抓取
        category: input.category || "测试",
      });
      const startedAt = Date.now();
      let item = normalized;

      // 强制指定抓取器
      // 前端发 "tikhub" / "tikhub_ocr" / "firecrawl" / "jina"
      // ⚠️ 强制选择某个抓取器但未配置对应 Key 时，明确报错提示，不做静默降级
      if ((input.force_fetcher === "tikhub" || input.force_fetcher === "tikhub_ocr") && !env.TIKHUB_API_KEY) {
        return withCors(json({ ok: false, error: "未配置 TIKHUB_API_KEY，无法强制使用 TikHub。请先在「配置部署」里配置 TikHub 的 API Key。" }));
      }
      if (input.force_fetcher === "firecrawl" && !env.FIRECRAWL_API_KEY) {
        return withCors(json({ ok: false, error: "未配置 FIRECRAWL_API_KEY，无法强制使用 Firecrawl。请先在「配置部署」里配置 Firecrawl 的 API Key，或改选「自动」。" }));
      }
      // 强制 OCR 必须配火山引擎 Key（测试页用途就是验证特定渠道，不能静默跳过）
      if (input.force_fetcher === "tikhub_ocr" && (!env.VOLC_ACCESS_KEY || !env.VOLC_SECRET_KEY)) {
        return withCors(json({ ok: false, error: "未配置火山引擎 OCR 的 Access Key / Secret Key，无法强制 OCR。请先在「配置部署」里配置，或改选「强制 TikHub」。" }));
      }
      if ((input.force_fetcher === "tikhub" || input.force_fetcher === "tikhub_ocr") && env.TIKHUB_API_KEY) {
        const forceOCR = input.force_fetcher === "tikhub_ocr";
        try {
          const tikhubResult = await fetchFromTikhub(input.source_url, env);
          if (tikhubResult.ok && tikhubResult.markdown) {
            item.text = tikhubResult.markdown;
            item.title = tikhubResult.title || item.title;
            item.author = tikhubResult.author || item.author;
            if (tikhubResult.published_at) item.published_at = tikhubResult.published_at.split('T')[0];
            item._jina_status = `tikhub_ok_len${item.text.length}_${Date.now() - startedAt}ms`;
            item._fetcher = "tikhub" + (forceOCR ? "+ocr" : "");
            item._quality = "ok";
            console.log(`[test-fetch] ✅ TikHub ok: ${item.text.length} chars`);

            // 🤖 图片OCR（小红书图文笔记，或强制 OCR 模式）
            const urlForPlatform = item.source_url || input.source_url || "";
            const needVision = forceOCR || /xiaohongshu\\\\.com|xhslink/i.test(urlForPlatform);
            if (item.text.length > 0 && needVision) {
              const beforeLen = item.text.length;
              const ocrResult = await enhanceWithVisionAI(item.text, env);
              if (ocrResult.length > beforeLen) {
                item.text = ocrResult;
                const visionMs = Date.now() - startedAt;
                item._jina_status += `+vision_${visionMs}ms`;
              } else if (forceOCR) {
                // 链接里没有图片：不算错误，结果里体现即可（用户选 OCR 只是想验证渠道可用）
                item._jina_status += "+vision_skip_no_images";
              }
            }
          } else if (input.force_fetcher === "tikhub" || input.force_fetcher === "tikhub_ocr") {
            // 强制渠道失败：反馈真实错误（不降级、不假装成功）
            return withCors(json({ ok: false, error: `TikHub 抓取失败: ${tikhubResult.error}` }));
          } else {
            item._jina_status = `tikhub_fail:${tikhubResult.error}`;
            item._fetcher = "tikhub";
            item._quality = "fail";
            item.text = `抓取失败: ${tikhubResult.error}`;
          }
        } catch (e) {
          if (input.force_fetcher === "tikhub" || input.force_fetcher === "tikhub_ocr") {
            return withCors(json({ ok: false, error: `TikHub 抓取异常: ${e.message}` }));
          }
          item._jina_status = `tikhub_exception:${e.message}`;
          item._fetcher = "tikhub";
          item._quality = "fail";
          item.text = `抓取异常: ${e.message}`;
        }
      } else if (input.force_fetcher === "firecrawl" && env.FIRECRAWL_API_KEY) {
        // 强制 Firecrawl
        try {
          const fc = await fetchFromFirecrawl(input.source_url, env);
          if (fc.ok && fc.markdown) {
            item.text = fc.markdown;
            item.title = fc.title || item.title;
            item._jina_status = `firecrawl_ok_${Date.now() - startedAt}ms`;
            item._fetcher = "firecrawl";
            item._quality = "ok";
          } else {
            // 强制渠道失败：反馈真实错误
            return withCors(json({ ok: false, error: `Firecrawl 抓取失败: ${fc.error}` }));
          }
        } catch (e) {
          return withCors(json({ ok: false, error: `Firecrawl 抓取异常: ${e.message}` }));
        }
      } else if (input.force_fetcher === "jina") {
        // 强制 Jina Reader
        try {
          const jina = await fetchFromJina(input.source_url, env);
          if (jina.markdown) {
            item.text = jina.markdown;
            item.title = jina.title || item.title;
            item._jina_status = `jina_ok_${Date.now() - startedAt}ms`;
            item._fetcher = "jina";
            item._quality = "ok";
          } else {
            // 强制渠道失败：反馈真实错误
            return withCors(json({ ok: false, error: `Jina Reader 抓取失败: ${jina.status}` }));
          }
        } catch (e) {
          return withCors(json({ ok: false, error: `Jina Reader 抓取异常: ${e.message}` }));
        }
      } else {
        // 自动按优先级
        await fetchArticleIfNeeded(item, env);
      }

      const durationMs = Date.now() - startedAt;
      // 测试页只展示抓取提取结果，不走 AI 分析 / Notion 写入等后续流程
      return withCors(json({
        ok: true,
        source_url: input.source_url,
        title: item.title,
        text: item.text || "",
        author: item.author,
        published_at: item.published_at,
        summary: item.summary,
        key_points: item.key_points,
        capture_device: item.capture_device,
        duration_ms: durationMs,
        _jina_status: item._jina_status,
        _fetcher: item._fetcher,
        _quality: item._quality,
      }));
    }

    // ===== 提示词动态配置 API =====

    // GET /api/config?token=xxx - 返回哪些 secret 已配置（env + D1）
    if (url.pathname === "/api/config" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      await loadSecretsFromDB(env);
      const keys = {
        ARK_API_KEY: !!env.ARK_API_KEY,
        LLM_BASE_URL: !!env.LLM_BASE_URL,
        LLM_MODEL: !!env.LLM_MODEL,
        TIKHUB_API_KEY: !!env.TIKHUB_API_KEY,
        FIRECRAWL_API_KEY: !!env.FIRECRAWL_API_KEY,
        NOTION_API_KEY: !!env.NOTION_API_KEY,
        NOTION_DATABASE_ID: !!env.NOTION_DATABASE_ID,
        BARK_KEY: !!env.BARK_KEY,
        INGEST_TOKEN: !!env.INGEST_TOKEN,
        VOLC_ACCESS_KEY: !!env.VOLC_ACCESS_KEY,
        VOLC_SECRET_KEY: !!env.VOLC_SECRET_KEY,
        JINA_API_KEY: !!env.JINA_API_KEY,
      };
      return withCors(json({ ok: true, keys }));
    }

    // POST /api/config?token=xxx - 保存 API Key 到 D1
    if (url.pathname === "/api/config" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not bound" }, 500));
      const body = await readJson(request);
      const allowed = ["ARK_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "TIKHUB_API_KEY", "FIRECRAWL_API_KEY", "NOTION_API_KEY", "NOTION_DATABASE_ID", "BARK_KEY", "VOLC_ACCESS_KEY", "VOLC_SECRET_KEY", "JINA_API_KEY"];
      const saved = [];
      for (const key of allowed) {
        if (key in body && typeof body[key] === "string" && body[key].trim()) {
          await env.kb_logs
            .prepare("INSERT INTO kb_config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')")
            .bind(key, body[key].trim(), body[key].trim())
            .run();
          saved.push(key);
        }
      }
      return withCors(json({ ok: true, saved }));
    }

    // POST /api/config-test?token=xxx - 测试单个 Key 连通性
    if (url.pathname === "/api/config-test" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const body = await readJson(request);
      const keyName = body.key;
      // 先把 D1 里保存的配置加载到 env（否则测试时 D1 里的 LLM_BASE_URL 等不生效）
      await loadSecretsFromDB(env);
      // 如果输入框有值，用输入框的值测试；否则用已配置的 env 值
      const testEnv = { ...env };
      if (body.value && body.value.trim()) testEnv[keyName] = body.value.trim();
      // 没填 Key 也不能为空，否则发空认证会被 API 误判为"有效"
      const testVal = testEnv[keyName];
      if (!testVal || !String(testVal).trim()) {
        return withCors(json({ ok: false, error: "请先填写 API Key 再测试" }));
      }

      try {
        let message = "";
        switch (keyName) {
          case "ARK_API_KEY": {
            const llmBaseUrl = normalizeLLMBaseUrl(testEnv.LLM_BASE_URL);
            const llmModel = testEnv.LLM_MODEL;
            const r = await callLLM({ llmBaseUrl, llmModel, apiKey: testEnv.ARK_API_KEY, systemPrompt: "你是测试助手", userContent: "hi" });
            if (r.ok) message = "AI API 连通正常";
            else { const t = await r.text(); return withCors(json({ ok: false, error: `AI API 返回 ${r.status}: ${t.slice(0, 100)}` })); }
            break;
          }
          case "TIKHUB_API_KEY": {
            // 用 webhook 端点验证 key 有效性
            const r = await fetchWithTimeout("https://api.tikhub.io/api/v1/tikhub/webhook", { headers: { Authorization: `Bearer ${testEnv.TIKHUB_API_KEY}` } });
            if (r.status === 401 || r.status === 403) { const t = await r.text(); return withCors(json({ ok: false, error: `TikHub 认证失败 (${r.status})` })); }
            else if (r.ok || r.status === 404 || r.status === 405) message = "TikHub Key 有效";
            else { const t = await r.text(); return withCors(json({ ok: false, error: `TikHub 返回 ${r.status}` })); }
            break;
          }
          case "FIRECRAWL_API_KEY": {
            // Firecrawl v0 端点
            const r = await fetchWithTimeout("https://api.firecrawl.dev/v0/credit-usage", { headers: { Authorization: `Bearer ${testEnv.FIRECRAWL_API_KEY}` } });
            if (r.ok) { const d = await r.json(); message = `Firecrawl 连通正常，剩余额度: ${d.data?.remaining_credits ?? "未知"}`; }
            else if (r.status === 401) return withCors(json({ ok: false, error: "Firecrawl 认证失败" }));
            else message = `Firecrawl 返回 ${r.status}（Key 可能有效）`;
            break;
          }
          case "NOTION_API_KEY": {
            const r = await fetchWithTimeout("https://api.notion.com/v1/users/me", { headers: { "Authorization": `Bearer ${testEnv.NOTION_API_KEY}`, "Notion-Version": "2022-06-28" } });
            if (r.ok) { const d = await r.json(); message = `Notion 连通正常，机器人: ${d.name || "未知"}`; }
            else { const t = await r.text(); return withCors(json({ ok: false, error: `Notion 返回 ${r.status}: ${t.slice(0, 100)}` })); }
            break;
          }
          case "NOTION_DATABASE_ID": {
            if (!testEnv.NOTION_API_KEY) return withCors(json({ ok: false, error: "需要先配置 NOTION_API_KEY" }));
            const r = await fetchWithTimeout(`https://api.notion.com/v1/databases/${testEnv.NOTION_DATABASE_ID}`, { headers: { "Authorization": `Bearer ${testEnv.NOTION_API_KEY}`, "Notion-Version": "2022-06-28" } });
            if (r.ok) { const d = await r.json(); message = `数据库可访问: ${d.title?.[0]?.plain_text || "无标题"}`; }
            else { const t = await r.text(); return withCors(json({ ok: false, error: `Notion 数据库返回 ${r.status}: ${t.slice(0, 100)}` })); }
            break;
          }
          case "BARK_KEY": {
            const r = await fetchWithTimeout(`https://api.day.app/${testEnv.BARK_KEY}/${encodeURIComponent("知识库配置测试")}/${encodeURIComponent("如果你收到了这条通知说明Bark配置正确")}`);
            if (r.ok) { const d = await r.json().catch(() => ({})); message = d.code === 200 ? "Bark 推送已发送，请检查手机通知" : "Bark 返回: " + JSON.stringify(d); }
            else return withCors(json({ ok: false, error: `Bark 返回 ${r.status}` }));
            break;
          }
          case "VOLC_ACCESS_KEY": {
            if (!testEnv.VOLC_SECRET_KEY) return withCors(json({ ok: false, error: "需要先配置 VOLC_SECRET_KEY" }));
            // 用一张 1x1 测试图片验证 AK/SK + OCR 服务是否可用
            const testBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
            try {
              await callVolcOCR(testBase64, testEnv.VOLC_ACCESS_KEY, testEnv.VOLC_SECRET_KEY);
              message = "火山引擎 OCR 连通正常";
            } catch (e) {
              const msg = e.message || "";
              // code=63001 = 测试图片太小导致 OCR 无法处理，但说明 AK/SK 签名和服务都正常
              if (msg.includes("63001") || msg.includes("code=10000") || msg.includes("line_texts")) {
                message = "火山引擎 OCR 连通正常（AK/SK 验证通过）";
              } else if (msg.includes("50013") || msg.includes("未开通") || msg.includes("Service")) {
                message = "Key 有效，但 OCR 服务可能未开通（请在控制台开通通用文字识别）";
              } else if (msg.includes("403") || msg.includes("401") || msg.includes("Signature") || msg.includes("Auth")) {
                return withCors(json({ ok: false, error: "AK/SK 认证失败: " + msg.slice(0, 150) }));
              } else {
                return withCors(json({ ok: false, error: "OCR 测试失败: " + msg.slice(0, 150) }));
              }
            }
            break;
          }
          case "VOLC_SECRET_KEY": {
            message = "Secret Key 已保存，可点击「测试连通」验证 Access Key ID";
            break;
          }
          case "LLM_BASE_URL": {
            message = "Base URL 已保存，可点击 AI 智能分析的测试验证连通性";
            break;
          }
          case "LLM_MODEL": {
            message = "模型名已保存，可点击 AI 智能分析的测试验证连通性";
            break;
          }
          case "INGEST_TOKEN": {
            message = "令牌格式正确，保存后即可用于鉴权";
            break;
          }
          case "JINA_API_KEY": {
            message = "Jina Key 已保存，抓取通用网页时会自动带上加速";
            break;
          }
          default:
            return withCors(json({ ok: false, error: "未知的 Key 名称" }));
        }
        return withCors(json({ ok: true, message }));
      } catch (e) {
        return withCors(json({ ok: false, error: e.message || String(e) }));
      }
    }

    // GET /api/prompts?token=xxx - 返回当前提示词
    if (url.pathname === "/api/prompts" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const isDefault = url.searchParams.get("default") === "1";
      if (isDefault) {
        return withCors(json({ ok: true, system_prompt: DEFAULT_SYSTEM_PROMPT, user_template: DEFAULT_USER_TEMPLATE, is_default: true }));
      }
      const { system_prompt, user_template, is_default } = await loadPromptsFromDB(env);
      return withCors(json({ ok: true, system_prompt, user_template, is_default }));
    }

    // POST /api/prompts?token=xxx - 保存提示词到 D1 kb_config (UPSERT)
    if (url.pathname === "/api/prompts" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      if (!env.kb_logs) return withCors(json({ ok: false, error: "D1 not bound" }, 500));
      const body = await readJson(request);
      const { system_prompt, user_template } = body;
      if (typeof system_prompt !== "string" || typeof user_template !== "string") {
        return withCors(json({ ok: false, error: "system_prompt 和 user_template 必须是字符串" }, 400));
      }
      const now = new Date().toISOString();
      await env.kb_logs
        .prepare(`INSERT INTO kb_config (key, value, updated_at) VALUES ('system_prompt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(system_prompt, now)
        .run();
      await env.kb_logs
        .prepare(`INSERT INTO kb_config (key, value, updated_at) VALUES ('user_template', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(user_template, now)
        .run();
      return withCors(json({ ok: true, message: "提示词已保存" }));
    }

    // POST /api/prompt-test?token=xxx - 用自定义提示词测试调用 AI 模型
    if (url.pathname === "/api/prompt-test" && request.method === "POST") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }
      const body = await readJson(request);
      await loadSecretsFromDB(env);
      const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : DEFAULT_SYSTEM_PROMPT;
      const userTemplate = typeof body.user_template === "string" ? body.user_template : DEFAULT_USER_TEMPLATE;
      const testItem = {
        title: body.title || "",
        text: body.text || "",
        source_platform: body.source_platform || "",
      };
      const userContent = renderUserTemplate(userTemplate, testItem);

      if (!env.ARK_API_KEY) {
        return withCors(json({ ok: false, error: "缺少 ARK_API_KEY，无法测试" }, 500));
      }

      try {
        const startTime = Date.now();
        const llmBaseUrl = normalizeLLMBaseUrl(env.LLM_BASE_URL);
        const llmModel = env.LLM_MODEL;
        const resp = await callLLM({ llmBaseUrl, llmModel, apiKey: env.ARK_API_KEY, systemPrompt, userContent });

        const bodyText = await resp.text();
        const durationMs = Date.now() - startTime;
        if (!resp.ok) {
          return withCors(json({ ok: false, error: `AI API 返回 ${resp.status}`, detail: bodyText.slice(0, 500) }, 502));
        }
        let parsed;
        try {
          parsed = JSON.parse(bodyText);
        } catch (e) {
          return withCors(json({ ok: false, error: `AI API 返回非 JSON: ${bodyText.slice(0, 200)}` }, 502));
        }
        let content = parsed?.choices?.[0]?.message?.content || "";
        // 去掉可能的 markdown 代码块包裹
        if (content.startsWith("```")) {
          content = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }
        let parsedContent = null;
        try {
          parsedContent = JSON.parse(content);
        } catch (_) {}
        return withCors(json({
          ok: true,
          parsed: parsedContent,
          raw_content: content,
          duration_ms: durationMs,
          model: parsed?.model || "",
          usage: parsed?.usage || {},
          finish_reason: parsed?.choices?.[0]?.finish_reason || "",
          user_content: userContent,
        }));
      } catch (e) {
        return withCors(json({ ok: false, error: e.message || String(e) }, 500));
      }
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
    source_url: enriched.source_url,
    published_at: enriched.published_at,
    author: enriched.author,
    coze_status: enriched.coze_status,
    coze_error: enriched.coze_error || undefined,
    notion_page_url: notion.url || null,
    notion_status: notion.status,
    notion_error: notion.error || undefined,
    // 🔍 调试字段：透传给上层debug_info
    debug_coze_input: enriched.debug_coze_input,
    debug_coze_parsed: enriched.debug_coze_parsed,
    debug_coze_raw_body: enriched.debug_coze_raw_body,
    // 🔍 Jina Reader抓取状态
    jina_status: normalized._jina_status || null,
    jina_error: normalized._jina_error || null,
    _debug_fetch: `text_len=${(normalized.text||"").length} url=${normalized.source_url} device=${normalized.capture_device}`,
    // 🆕 抓取质量 + Wayback 兜底状态
    _quality: normalized._quality || null,
    _wayback_status: normalized._wayback_status || null,
    _debug_tikhub: normalized._debug_tikhub || null,
  };
}

export async function searchKnowledge(query, topK = 5, env = {}) {
  // Dify 向量检索已移除，后续可用 Notion API 关键词搜索替代
  return {
    ok: true,
    query,
    results: [],
    source: "disabled",
  };
}

function normalizeSourcePlatform(sourcePlatform, host = "") {
  const platformLower = String(sourcePlatform || "").toLowerCase().trim();
  const hostLower = String(host || "").toLowerCase().trim();

  // 标准化成中文，不管输入是英文还是中文
  const mapping = [
    [["zhihu", "知乎"], "知乎"],
    [["bilibili", "b站", "bilibil", "bili", "b23"], "B站"],
    [["xiaohongshu", "小红书", "xhs"], "小红书"],
    [["douyin", "抖音"], "抖音"],
    [["weibo", "微博"], "微博"],
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
  // null/非对象输入容错
  if (!input || typeof input !== "object") input = {};
  // 用 safeUrl 容错：非法 URL 不抛异常，host 为空则由 normalizeSourcePlatform 兜底返回"网页"
  const host = safeUrl(input.source_url || "https://example.com")?.hostname || "";
  const sourcePlatform = normalizeSourcePlatform(input.source_platform, host);
  const text = stringOrEmpty(input.text || input.raw_text || input.content).trim();
  // 清洗标题：去掉知乎的私信、消息、后缀等垃圾信息
  function cleanTitle(title) {
    if (!title) return "";
    let t = title
      .replace(/^\(\d+\+? 封私信 \/ \d+ 条消息\)\s*/, "")
      .replace(/^\(\d+\+? 封私信\)\s*/, "")
      .replace(/^\(\d+ 条消息\)\s*/, "")
      .replace(/^\(\d+\+? 条新消息\)\s*/, "")
      .replace(/\s*-\s*知乎\s*$/g, "")
      .replace(/\s*-\s*知乎专栏\s*$/g, "")
      .replace(/\s*-\s*知乎日报\s*$/g, "")
      .replace(/\s*-\s*知乎盐选\s*$/g, "")
      .trim();
    // 如果是 [xxx](url) markdown 链接格式，提取 xxx
    const mdLink = t.match(/^\[([^\]]{5,})\]\(https?:\/\/[^)]+\)$/);
    if (mdLink) t = mdLink[1].trim();
    return t;
  }

  const title = (cleanTitle(stringOrEmpty(input.title).trim()) || guessTitle(text, input.source_url)).slice(0, 500);
  const sourceUrl = stringOrEmpty(input.source_url || input.url).trim().slice(0, 2000);
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
  console.log(`[Fetch] 入口: text_len=${text.length} url=${url} device=${captureDevice} text_head=${text.slice(0,60)}`);

  if (!url) {
    console.log("[Fetch] 跳过抓取，无source_url");
    return;
  }

  // 正文是否就是纯链接（用于后续判断）
  const textIsJustUrl = text.length < 500 && /^https?:\/\//i.test(text);
  // 分享文案：text 含已知平台域名但不是纯 URL
  const isShareText = /(xhslink\.(cn|com)|b23\.tv|zhihu\.com|bilibili\.com|xiaohongshu\.com|mp\.weixin\.qq\.com|douyin\.com|weibo\.com)/i.test(text) && !textIsJustUrl && text.length < 500;

  // 🆕 已知 App 独占分享域名 / 路径 -- 网页里根本没内容，直接跳过抓取
  const appOnlyPatterns = [
    /^https?:\/\/oia\.zhihu\.com\//i,       // 知乎盐选/付费/App 分享
    /\/km_paid_content\//i,                  // 知乎付费专栏
    /^https?:\/\/oia\.mp\.weixin\.qq\.com\//i, // 微信 App 独占分享（如果有）
  ];
  if (appOnlyPatterns.some(re => re.test(url))) {
    console.log(`[Fetch] ⚠️ 已知 App 独占分享链，网页版无内容，跳过抓取：${url}`);
    item._jina_status = "skip_app_only_domain";
    item._quality = "app_only";
    return;
  }

  // ==================== 🎬 TikHub 提取分支（已知平台强制走，不管正文多长） ====================
  // 已知平台正则：小红书/B站/知乎/微信公众号/微信视频号/抖音/微博
  const KNOWN_PLATFORM_RE = /(xiaohongshu\.com|xhslink\.(cn|com)|bilibili\.com|b23\.tv|zhihu\.com|mp\.weixin\.qq\.com|channels\.weixin\.qq\.com|weixin\.qq\.com\/sph|douyin\.com|iesdouyin\.com|v\.douyin\.com|weibo\.com|weibo\.cn)/i;
  const isKnownPlatform = KNOWN_PLATFORM_RE.test(url);
  const isIOS = captureDevice === "ios";

  // 手机端：已知平台直接走 TikHub，不走正文判断
  // 电脑端：已知平台也直接走 TikHub（Chrome 插件抓的内容不是最终内容）
  // 未知平台：手机端直接 Firecrawl，电脑端先判断正文够不够
  if (!isKnownPlatform) {
    if (isIOS) {
      // 手机端未知平台：正文肯定空，直接抓
      console.log(`[Fetch] 手机端未知平台，直接抓取: ${url}`);
    } else {
      // 电脑端未知平台：判断正文够不够用
      const textSufficient = text.length > 500 && !textIsJustUrl && !isShareText;
      if (textSufficient) {
        console.log(`[Jina] 跳过抓取，text已有正文（长度：${text.length}，device：${captureDevice}）`);
        return;
      }
      console.log(`[Fetch] 电脑端未知平台，正文不够，触发抓取: text_len=${text.length}`);
    }
  } else {
    console.log(`[Fetch] 已知平台，强制走 TikHub: ${url}`);
  }

  if (env.TIKHUB_API_KEY && isKnownPlatform) {
    try {
      console.log(`[TikHub-ingest] url=${url} platform=${tikhubDetectPlatform(url)}`);
      const tikhubResult = await fetchFromTikhub(url, env);
      // 🆕 debug: 记录 TikHub 返回的原始信息
      item._debug_tikhub = `url=${url}|ok=${tikhubResult.ok}|title=${(tikhubResult.title||"").slice(0,60)}|markdown_len=${(tikhubResult.markdown||"").length}|error=${tikhubResult.error||""}`;
      if (tikhubResult.ok && tikhubResult.markdown) {
        item.text = tikhubResult.markdown;
        if (tikhubResult.title) item.title = tikhubResult.title;
        if (tikhubResult.author) item.author = tikhubResult.author;
        if (tikhubResult.published_at) item.published_at = tikhubResult.published_at.split('T')[0];
        item._jina_status = `tikhub_ok_len${item.text.length}`;
        item._fetcher = "tikhub";
        item._quality = "ok";
        console.log(`[TikHub-ingest] ✅ title=${tikhubResult.title?.slice(0,50)} text=${item.text.length}chars`);

        // 🤖 图片OCR：仅小红书图文笔记（微信文章正文已是文字，图片多为配图不值得OCR）
        const pipelineUrl = item.source_url || url || "";
        const needVision = /xiaohongshu\.com|xhslink/i.test(pipelineUrl);
        if (item.text.length > 0 && needVision) {
          try {
            const beforeLen = item.text.length;
            item.text = await enhanceWithVisionAI(item.text, env);
            if (item.text.length > beforeLen) {
              console.log(`[VisionAI] ✅ 图片识别完成，新增 ${item.text.length - beforeLen} 字符`);
              item._jina_status += "+vision";
            }
          } catch (e) {
            console.log(`[VisionAI] ❌ 识别失败: ${e.message}`);
          }
        }

        return;
      } else {
        console.log(`[TikHub] ❌ ${tikhubResult.error}，降级到 Firecrawl`);
        item._jina_status = `tikhub_fail:${tikhubResult.error}`;
      }
    } catch (err) {
      console.error("[TikHub] 异常:", err.message);
      item._jina_status = `tikhub_exception:${err.message}`;
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
        // 🆕 顺手拿 title：iOS 场景 item.title 可能就是 URL 或域名，需要覆盖
        const currTitle = String(item.title || "").trim();
        const titleIsUrl = /^https?:\/\//i.test(currTitle);
        const titleIsDomain = /^(mp\.weixin\.qq\.com|[a-z0-9.-]+\.[a-z]{2,})$/i.test(currTitle);
        // Firecrawl 的 title 如果是域名（如 mp.weixin.qq.com），不覆盖
        const fcTitleIsDomain = fc.title && /^(mp\.weixin\.qq\.com|[a-z0-9.-]+\.[a-z]{2,})$/i.test(fc.title.trim());
        if (fc.title && !fcTitleIsDomain && (!currTitle || titleIsUrl || titleIsDomain || currTitle.length < 5)) {
          item.title = fc.title;
        }
        // 如果 title 还是域名/空，从 markdown 提取标题
        if ((!item.title || titleIsDomain || /^(mp\.weixin\.qq\.com|[a-z0-9.-]+\.[a-z]{2,})$/i.test(String(item.title).trim())) && markdown) {
          const lines = markdown.split(/\n+/).map(s => s.trim()).filter(s => s && !s.startsWith("!"));
          // 优先找 # 标题行（微信文章结构：第一行是作者名，第二行 # 才是标题）
          const headingLine = lines.find(s => /^#{1,3}\s+/.test(s) && s.replace(/^#+\s*/, "").length > 3);
          if (headingLine) {
            item.title = headingLine.replace(/^#+\s*/, "").slice(0, 100);
            // 微信文章 # 标题行之前的第一行通常是公众号名（作者）
            const idx = lines.indexOf(headingLine);
            if (idx > 0 && !item.author) {
              const possibleAuthor = lines[idx - 1];
              if (possibleAuthor.length > 1 && possibleAuthor.length < 30 && !/^#{1,3}\s/.test(possibleAuthor)) {
                item.author = possibleAuthor;
              }
            }
          } else {
            // 没有 # 标题，取第一行有意义的文本（跳过纯域名/作者行）
            const firstMeaningful = lines.find(s => s.length > 5 && !/^(mp\.weixin\.qq\.com|[a-z0-9.-]+\.[a-z]{2,})$/i.test(s));
            if (firstMeaningful) {
              item.title = firstMeaningful.slice(0, 100);
            }
          }
        }
        // 清洗 title：如果是 [xxx](url) markdown 链接格式，提取 xxx
        const titleStr = String(item.title || "").trim();
        const mdLinkMatch = titleStr.match(/^\[([^\]]{5,})\]\(https?:\/\/[^)]+\)$/);
        if (mdLinkMatch) {
          item.title = mdLinkMatch[1].trim().slice(0, 100);
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
      if (jinaResult.title && (!item.title || item.title === url || /^(mp\.weixin\.qq\.com|[a-z0-9.-]+\.[a-z]{2,})$/i.test(String(item.title).trim()) || item.title.length < 5)) {
        item.title = jinaResult.title;
      }
    } else {
      fetchStatus = (fetchStatus ? fetchStatus + " | " : "") + (jinaResult.status || "jina_empty");
    }
  }

  const totalDuration = Date.now() - startTime;
  // 保留 TikHub 失败信息作为前缀，方便排查
  const tikhubFailInfo = item._jina_status && item._jina_status.startsWith("tikhub_fail") ? item._jina_status + " | " : "";
  item._jina_status = tikhubFailInfo + fetchStatus; // 保持字段名兼容监控台，实际是"fetch_status"
  item._fetcher = fetcher;

  if (!markdown || markdown.length < 100) {
    console.log(`[Fetch] ❌ 全部抓取失败 (${totalDuration}ms)`);
    // 兜底：如果 Chrome 插件抓到了正文，用它
    if (text.length > 100) {
      console.log(`[Fetch] 🆘 用浏览器已有正文兜底 (${text.length} chars)`);
      item._jina_status = (fetchStatus || "") + "|fallback_browser_text";
      item._quality = "fallback_browser";
      return;
    }
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

// ========== TikHub 提取已改为 import ./extractor/index.js ==========
// 🤖 图片识别（Cloudflare Workers AI - Llama 3.2 Vision）
// 从 Markdown 中提取图片 URL，逐张识别，结果追加到 Markdown 末尾
// ============ 火山引擎 V4 签名 ============
async function hmacSha256(key, data) {
  const enc = new TextEncoder();
  const keyData = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return globalThis.crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

async function sha256Hex(data) {
  const enc = new TextEncoder();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(data));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function volcSignV4(method, url, body, ak, sk) {
  const urlObj = new URL(url);
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const shortDate = xDate.substring(0, 8);
  const region = "cn-north-1";
  const service = "cv";

  const params = new URLSearchParams(urlObj.search);
  const sortedParams = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const canonicalQueryString = sortedParams.map(([k, v]) =>
    encodeURIComponent(k) + "=" + encodeURIComponent(v)
  ).join("&");

  const host = urlObj.host;
  const canonicalHeaders = `content-type:application/x-www-form-urlencoded\nhost:${host}\nx-date:${xDate}\n`;
  const signedHeaders = "content-type;host;x-date";
  const hashedPayload = await sha256Hex(body);
  const canonicalRequest = `${method.toUpperCase()}\n/\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const kDate = await hmacSha256(sk, shortDate);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "request");
  const signature = await hmacSha256(kSigning, stringToSign);

  return `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${bufToHex(signature)}`;
}

// ============ 火山引擎通用文字识别 OCR ============
async function callVolcOCR(base64, ak, sk) {
  const url = "https://visual.volcengineapi.com/?Action=OCRNormal&Version=2020-08-26";
  const body = `image_base64=${encodeURIComponent(base64)}`;
  const auth = await volcSignV4("POST", url, body, ak, sk);
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Date": xDate,
      "Authorization": auth,
    },
    body: body,
  });

  const data = await resp.json();
  if (data.code === 10000 && data.data?.line_texts) {
    return data.data.line_texts.join("\n");
  }
  throw new Error(`OCR code=${data.code} msg=${data.message || JSON.stringify(data).slice(0, 200)}`);
}

// ============ 图片内容识别（OCR）============
async function enhanceWithVisionAI(markdown, env, maxImages = 20) {
  // 提取图片 URL
  const imgUrls = [];
  const allUrls = markdown.match(/https?:\/\/[^\s\)\]"']+/gi) || [];
  for (const u of allUrls) {
    if (/\.(?:jpg|jpeg|png|webp|gif|jfif|avif)/i.test(u) ||
        /(zhimg\.com|sns-img|rednotecdn|xhscdn|mmbiz\.qpic\.cn)/i.test(u) ||
        /(imageView2|format\/webp|format\/png|format\/jpg)/i.test(u)) {
      imgUrls.push(u);
    }
  }

  const unique = [...new Set(imgUrls)].slice(0, maxImages);
  if (unique.length === 0) return markdown;

  // 检查是否有 OCR 密钥
  if (!env.VOLC_ACCESS_KEY || !env.VOLC_SECRET_KEY) {
    console.log("[OCR] 缺少 VOLC_ACCESS_KEY/VOLC_SECRET_KEY，跳过图片识别");
    return markdown;
  }

  console.log(`[OCR] 发现 ${imgUrls.length} 张图片，识别前 ${unique.length} 张（串行，避免QPS超限）`);

  // 串行识别（火山OCR免费QPS=1，不能并发）
  const results = [];
  for (let i = 0; i < unique.length; i++) {
    const imgUrl = unique[i];
    try {
      const imgResp = await fetch(imgUrl, {
        headers: { "Referer": "https://www.zhihu.com" }
      });
      if (!imgResp.ok) {
        console.log(`[OCR] 图片 ${i + 1} 下载失败: ${imgResp.status}`);
        results.push({ url: imgUrl, text: `[图片下载失败: HTTP ${imgResp.status}]`, model: "none" });
        continue;
      }
      const buf = await imgResp.arrayBuffer();
      if (buf.byteLength > 8 * 1024 * 1024) {
        console.log(`[OCR] 图片 ${i + 1} 太大 (${buf.byteLength} bytes)，跳过`);
        results.push({ url: imgUrl, text: `[图片过大，跳过识别]`, model: "none" });
        continue;
      }
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunkSize = 8192;
      for (let j = 0; j < bytes.length; j += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(j, j + chunkSize));
      }
      const base64 = btoa(binary);

      const text = await callVolcOCR(base64, env.VOLC_ACCESS_KEY, env.VOLC_SECRET_KEY);
      console.log(`[OCR] 图片${i + 1} 识别完成: ${text.length}字`);
      results.push({ url: imgUrl, text: text.trim(), model: "volc-ocr" });
    } catch (e) {
      console.log(`[OCR] 图片 ${i + 1} 识别失败: ${e.message}`);
      results.push({ url: imgUrl, text: `[识别失败: ${e.message.slice(0, 100)}]`, model: "fail" });
    }
  }

  if (results.length === 0) return markdown;

  // 去掉原始的"## 图片"URL列表（OCR已包含内容，URL对AI无意义）
  let cleaned = markdown.replace(/\n## 图片\n[\s\S]*?(?=\n## |\n$|$)/, "");
  // 去掉末尾多余的 "- url" 残留
  cleaned = cleaned.replace(/\n(?:- https?:\/\/[^\n]+\n)+\s*$/, "\n");

  let visionSection = "\n\n## 🖼️ 图片文字提取\n";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    visionSection += `\n[图${i + 1}]\n${r.text}\n`;
  }

  return cleaned + visionSection;
}

// 微信公众号文章 & 视频号 提取（TikHub POST 接口）
async function fetchWechatArticle(url, env) {
  const apiUrl = "https://api.tikhub.io/api/v1/wechat_mp/v2/fetch_article_detail";
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TIKHUB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, raw: false }),
  });
  if (!resp.ok) throw new Error(`WeChat MP API ${resp.status}`);
  const body = await resp.json();

  // TikHub 返回结构：body.data.content 可能是 HTML 字符串，也可能是对象（含 title/content_text 等）
  // 需要兼容两种情况
  const rawData = body?.data || {};
  const rawContent = rawData.content;

  let title = "";
  let author = "";
  let text = "";
  let cover = "";
  let publishedAt = "";

  if (typeof rawContent === "string") {
    // content 是 HTML 字符串 -- 去标签转纯文本
    text = rawContent
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // 从 HTML 里提取 title
    const titleMatch = rawContent.match(/<title[^>]*>([^<]+)<\/title>/i)
      || rawContent.match(/<h1[^>]*>([^<]+)<\/h1>/i)
      || rawContent.match(/<meta[^>]+og:title[^>]+content="([^"]+)"/i);
    if (titleMatch) title = titleMatch[1].trim();
    // 从 HTML 里提取作者
    const authorMatch = rawContent.match(/<meta[^>]+og:article:author[^>]+content="([^"]+)"/i)
      || rawContent.match(/var\s+nickname\s*=\s*['"]([^'"]+)['"]/i);
    if (authorMatch) author = authorMatch[1].trim();
  } else if (rawContent && typeof rawContent === "object") {
    // content 是对象（旧版 API 格式）
    const c = rawContent;
    title = c.title || "";
    author = c.nick_name || c.author || "";
    text = c.content_text || c.desc || "";
    cover = c.cdn_url || "";
    publishedAt = c.create_time || "";
  }

  // 如果 TikHub 没返回正文，抛错让上层降级到 Firecrawl
  if (!text || text.length < 50) {
    throw new Error(`TikHub 微信接口返回空内容 (content_len=${text.length}, bizUin=${rawData.bizUin})`);
  }

  // 构建 Markdown
  let md = `---\ntitle: "${title}"\nsource: "${url}"\nplatform: wechat_mp\nauthor: "${author}"\npublished_at: "${publishedAt}"\ncaptured_at: "${new Date().toISOString()}"\ncontent_type: article\n---\n\n# ${title}\n\n${text}\n`;
  if (cover) md += `\n## 封面\n\n- ${cover}\n`;
  return { ok: true, title, author, publishedAt: publishedAt.split(" ")[0] || "", markdown: md };
}

async function fetchWechatChannels(shareUrl, env) {
  const apiUrl = "https://api.tikhub.io/api/v1/wechat_channels/v2/fetch_video_detail";
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TIKHUB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ share_url: shareUrl, raw: false }),
  });
  if (!resp.ok) throw new Error(`WeChat Channels API ${resp.status}`);
  const body = await resp.json();
  const d = body?.data || {};
  const title = d.title || "";
  const author = d.nickname || "";
  const desc = d.desc || "";
  // create_time 是 Unix 秒时间戳
  const ts = d.create_time;
  const publishedAt = ts ? new Date(ts * 1000).toISOString() : "";
  const likeCount = d.like_count || 0;
  const commentCount = d.comment_count || 0;
  const forwardCount = d.forward_count || 0;
  const media = d.media || {};
  const duration = media.duration || 0;
  const cover = d.cover_img_url || media.cover_url || "";
  const videoUrl = media.url || "";

  // 构建带时间戳的 mm:ss 格式
  const fmtDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  let md = `---\ntitle: "${title}"\nsource: "${shareUrl}"\nplatform: wechat_channels\nauthor: "${author}"\npublished_at: "${publishedAt}"\ncaptured_at: "${new Date().toISOString()}"\ncontent_type: video\nduration_seconds: ${duration}\n---\n\n# ${title}\n\n${desc}\n\n## 视频信息\n\n- **UP主**: ${author}\n- **时长**: ${fmtDuration(duration)}\n- **点赞**: ${likeCount}\n- **评论**: ${commentCount}\n- **转发**: ${forwardCount}\n`;
  if (cover) md += `\n## 封面\n\n- ${cover}\n`;
  if (videoUrl) md += `\n## 视频地址\n\n- ${videoUrl}\n`;
  md += `\n> ⚠️ 视频号视频无字幕接口，仅提取元数据。如需字幕请使用其他方式。\n`;
  return { ok: true, title, author, published_at: publishedAt.split("T")[0], markdown: md };
}

// 以下是桥接函数，把 extractor 的返回格式适配成 worker pipeline 期望的格式
async function fetchFromTikhub(rawUrl, env) {
  // 从分享文案中提取纯 URL（和 extractor ui.js 的 extractUrl 逻辑一致）
  const urlMatch = rawUrl.match(/https?:\/\/[^\s；;]+/i);
  const url = urlMatch ? urlMatch[0].replace(/[。，、!！?？~～]+$/g, "") : rawUrl.trim();

  const extractorEnv = { ...env, TIKHUB_TOKEN: env.TIKHUB_API_KEY };

  // 微信搜索短链 search.weixin.qq.com -> 跟随重定向拿真实 URL
  let finalUrl = url;
  if (/search\.weixin\.qq\.com|weixin\.qq\.com\/cgi-bin/i.test(url)) {
    try {
      const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      finalUrl = r.url || url;
      console.log(`[TikHub] 微信短链重定向: ${url} -> ${finalUrl}`);
    } catch (e) {
      console.log(`[TikHub] 微信短链重定向失败: ${e.message}`);
    }
  }

  // 微信公众号文章 & 视频号：POST 接口，不走 extractor
  if (/mp\.weixin\.qq\.com/i.test(finalUrl)) {
    try {
      return await fetchWechatArticle(finalUrl, env);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (/weixin\.qq\.com\/sph\//i.test(url) || /channels\.weixin\.qq\.com/i.test(url)) {
    try {
      return await fetchWechatChannels(url, env);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const platform = tikhubDetectPlatform(url);

  // TikHub 知乎接口有时返回安全验证页面（非报错，而是返回拦截页内容）
  // B站字幕也可能需要重试
  const maxRetries = (platform === "bilibili") ? 2 : (platform === "zhihu" ? 3 : 1);
  let lastError = "";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const content = await tikhubExtract(url, platform, extractorEnv);
      const document = tikhubNormalize(content, url, platform);
      const markdown = tikhubToMarkdown(document);
      // 检测 TikHub 返回的是否是拦截页（安全验证/登录墙）
      const blocked = detectBlockedPage(markdown);
      if (blocked && attempt < maxRetries) {
        console.log(`[TikHub] 第${attempt}/${maxRetries}次返回拦截页（${blocked}），等2秒重试`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return {
        ok: true,
        title: document.title,
        author: document.author || "",
        published_at: document.published_at || "",
        markdown,
      };
    } catch (e) {
      lastError = e.message;
      // 只有字幕相关的错误才重试
      if (!lastError.includes("subtitle") && !lastError.includes("no accessible")) {
        break;
      }
    }
  }
  return { ok: false, error: lastError };
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
  const hasKey = !!env.JINA_API_KEY;
  console.log(`[Jina] 开始抓取: ${jinaUrl} ${hasKey ? "(已配 Key)" : "(未配 Key, 走免费额度, 可能较慢)"}`);
  const start = Date.now();
  try {
    const headers = {
      "Accept": "text/plain",
      "X-Return-Format": "markdown",
      "X-Engine": "browser",
      "X-With-Generated-Alt": "true",
    };
    if (hasKey) {
      const B = "Bea" + "rer";
      headers["Authorization"] = `${B} ${env.JINA_API_KEY}`;
    }
    // 30s 超时（Jina 免费额度排队可能很久）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(jinaUrl, { headers, signal: controller.signal });
    clearTimeout(timeoutId);
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
    const duration = Date.now() - start;
    if (err.name === "AbortError") {
      return { markdown: "", title: "", status: `jina_timeout_30s_${duration}ms${hasKey ? "" : "(未配Key,免费额度排队超时)"}` };
    }
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
      headers: { "User-Agent": "knowledge-space-worker/1.0" },
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

// ===== 提示词默认值（可通过 D1 kb_config 表动态覆盖）=====
const DEFAULT_SYSTEM_PROMPT = (
  "你是我的个人知识空间整理助手。\n"
  + "目标：把用户分享的网页、帖子、视频字幕、截图OCR、ChatGPT对话或文档片段整理成结构化知识条目，帮助我以后快速回忆、筛选、检索和复用这条信息。\n\n"
  + "输出约束：只输出 JSON，不输出 Markdown、解释或代码块。\n"
  + "JSON 只包含这些字段：title, summary, key_points, category, tags, entities。\n"
  + "所有字段内容用中文，技术术语、产品名保留英文。\n"
  + "如果输入是视频字幕（通常没有标点、按句断开），先在脑海中理解完整叙事再提炼核心观点，不要被逐句碎片干扰。\n"
);

const DEFAULT_USER_TEMPLATE = (
  "标题：{{title}}\n"
  + "来源平台：{{source_platform}}\n"
  + "原文内容：{{text}}\n\n"
  + "请输出 JSON：\n"
  + "{\n"
  + '  "title": "最终标题，去掉 99+封私信 等前缀废话",\n'
  + '  "summary": "中文摘要，包含三部分：①这条内容讲什么主题 ②核心判断或核心方法是什么 ③对我的工作/客户/方案有什么用或怎么复用。120-350 字，最长不超 500 字",\n'
  + '  "key_points": ["提炼后的要点（2-4条，每条是结论或判断，不能抄原文）"],\n'
  + '  "category": "从这些分类中选一个：AI技术、云计算与基础设施、软件工程、数据与安全、其他技术、行业研究、商业与金融、效率工具、个人成长、社会与历史、生活、其他",\n'
  + '  "tags": ["从标签池选3-6个：大模型、AI Agent、RAG、企业知识库、AI工作流、AI Coding、AI Infra、模型训练、模型推理、多模态、Prompt工程、模型评测、AI应用落地、私有化部署、云计算、云原生、虚拟化、容器、分布式存储、网络架构、高可用、性能优化、软件架构、API集成、自动化脚本、DevOps、开发范式、工程效率、数据治理、数据分析、数据库、大数据、数据隐私、网络安全、身份权限、行业趋势、企业数字化、制造业、智能制造、供应链、港口物流、汽车产业、出海全球化、信创、商业模式、产品策略、客户需求、解决方案、销售方法、竞品分析、项目管理、ROI分析、股票投资、房地产、宏观经济、货币政策、资本市场、行业轮动、国际局势、科技政策、产业政策、历史、个人知识管理、办公自动化、工作流自动化、信息检索、写作表达、学习方法、思维模型、职业发展、菜谱、美食、旅行、健康、运动、家居、其他"],\n'
  + '  "entities": "具体的公司、产品、工具、人物、技术术语，多个用逗号分隔"\n'
  + "}\n\n"
  + "只输出 JSON，不要其他任何内容。"
);

// 从 D1 kb_config 表读取提示词，没有则用默认值
async function loadPromptsFromDB(env) {
  let system_prompt = DEFAULT_SYSTEM_PROMPT;
  let user_template = DEFAULT_USER_TEMPLATE;
  let is_default = true;
  if (env.kb_logs) {
    try {
      const row = await env.kb_logs
        .prepare("SELECT key, value FROM kb_config WHERE key IN ('system_prompt','user_template')")
        .all();
      if (row.results && row.results.length) {
        for (const r of row.results) {
          if (r.key === "system_prompt" && r.value) {
            system_prompt = r.value;
            is_default = false;
          }
          if (r.key === "user_template" && r.value) {
            user_template = r.value;
            is_default = false;
          }
        }
      }
    } catch (e) {
      console.warn("[prompt] 读取 kb_config 失败，使用默认值:", e.message);
    }
  }
  return { system_prompt, user_template, is_default };
}

// D1 中存储的 secret key 名称
const SECRET_KEYS = ["ARK_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "TIKHUB_API_KEY", "FIRECRAWL_API_KEY", "NOTION_API_KEY", "NOTION_DATABASE_ID", "BARK_KEY", "VOLC_ACCESS_KEY", "VOLC_SECRET_KEY", "JINA_API_KEY"];

// 从 D1 加载 secrets，覆盖到 env（D1 优先于 wrangler secret）
async function loadSecretsFromDB(env) {
  if (!env.kb_logs) return;
  try {
    const rows = await env.kb_logs
      .prepare(`SELECT key, value FROM kb_config WHERE key IN (${SECRET_KEYS.map(() => "?").join(",")})`)
      .bind(...SECRET_KEYS)
      .all();
    if (rows.results) {
      for (const r of rows.results) {
        if (r.value) env[r.key] = r.value;
      }
    }
  } catch (e) {
    console.warn("[secrets] 读取 kb_config 失败:", e.message);
  }
}

// 把 user_template 中的占位符替换为实际内容
function renderUserTemplate(template, item) {
  return template
    .replace(/\{\{title\}\}/g, item.title || "")
    .replace(/\{\{source_platform\}\}/g, item.source_platform || "")
    .replace(/\{\{text\}\}/g, (item.text || "").slice(0, 12000));
}

// 归一化 LLM Base URL：兼容用户填 base 或完整 /chat/completions 两种写法
// 未配置时返回空串（调用方需报错提示，不提供任何默认供应商）
function normalizeLLMBaseUrl(value) {
  const v = String(value || "").trim().replace(/\/+$/, "");
  if (!v) return "";
  if (v.endsWith("/chat/completions")) return v;
  return `${v}/chat/completions`;
}

// 统一调用 OpenAI 兼容 LLM，带参数降级重试：
//   1) response_format: {type:"json_object"}  + max_tokens
//   2) 若 400（供应商不认 response_format/max_tokens），去掉 response_format 重试
//   3) 若仍 400，改用 max_completion_tokens（OpenAI 新模型）
// 保证任何声明 OpenAI 兼容的接口都能调通。
async function callLLM({ llmBaseUrl, llmModel, apiKey, systemPrompt, userContent }) {
  const base = normalizeLLMBaseUrl(llmBaseUrl);
  const model = String(llmModel || "").trim();
  // 不提供默认供应商：缺配置直接抛错，提示用户在配置页填写
  if (!base) throw new Error("未配置 LLM_BASE_URL，请到「配置部署 → AI 智能分析」填写你的大模型接口地址");
  if (!model) throw new Error("未配置 LLM_MODEL，请到「配置部署 → AI 智能分析」填写模型名");
  if (!apiKey) throw new Error("未配置 API Key，请到「配置部署 → AI 智能分析」填写");
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  // 第 1 次：完整参数
  let resp = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, max_tokens: 4000, temperature: 0.3 }),
  });
  if (resp.ok) return resp;

  // 第 2 次：去掉 response_format（部分兼容供应商不认）
  if (resp.status === 400) {
    resp = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: 4000, temperature: 0.3 }),
    });
    if (resp.ok) return resp;
  }

  // 第 3 次：用 max_completion_tokens（OpenAI 新模型废弃了 max_tokens）
  if (resp.status === 400) {
    resp = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, max_completion_tokens: 4000, temperature: 0.3 }),
    });
  }
  return resp;
}

export async function enrichWithCoze(item, env = {}) {
  // 使用 OpenAI 兼容接口的大模型（DeepSeek/OpenAI/通义/豆包等），key 存于 ARK_API_KEY
  // 未配置 key 时走 fallbackEnrich（不调用 AI）
  if (!env.ARK_API_KEY) {
    console.log("[Ark] 跳过Ark调用，缺少ARK_API_KEY");
    return fallbackEnrich(item);
  }

  const cozeInput = {
    title: item.title,
    text: item.text,
    source_platform: item.source_platform,
  };

  try {
    // 从 D1 读取动态提示词，没有则用默认
    const { system_prompt: systemPrompt, user_template: userTemplate } = await loadPromptsFromDB(env);
    const userContent = renderUserTemplate(userTemplate, item);

    const llmBaseUrl = normalizeLLMBaseUrl(env.LLM_BASE_URL);
    const llmModel = env.LLM_MODEL;
    const resp = await callLLM({ llmBaseUrl, llmModel, apiKey: env.ARK_API_KEY, systemPrompt, userContent });

    const bodyText = await resp.text();

    if (!resp.ok) {
      const errorResult = { ...fallbackEnrich(item), coze_status: "failed", coze_error: bodyText.slice(0, 500) };
      errorResult.debug_coze_input = cozeInput;
      console.error("[Ark] 请求失败，状态码:", resp.status);
      return errorResult;
    }

    const body = JSON.parse(bodyText);
    let content = body?.choices?.[0]?.message?.content || "";

    // 去掉可能的 markdown 代码块包裹
    if (content.startsWith("```")) {
      content = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    let data = {};
    if (content) {
      try {
        data = JSON.parse(content);
      } catch (e) {
        console.error("[Ark] JSON解析失败:", e.message, "content head:", content.slice(0, 100));
      }
    }

    // 检查是否有有效字段
    const hasData = data && (data.title || data.summary || data.tags || data.category || data.key_points);
    if (!hasData) {
      console.error("[Ark] 返回内容无有效字段，content_len:", content.length);
      data = {};
    }

    const result = mergeEnrichment(item, data, "ok");

    result.debug_final_author = result.author;
    result.debug_final_published_at = result.published_at;
    result.debug_coze_input = cozeInput;
    result.debug_coze_parsed = data;
    result.debug_coze_raw_body = { model: body?.model, usage: body?.usage, finish_reason: body?.choices?.[0]?.finish_reason };

    console.log("[Ark] 处理完成，分类:", data.category, "标签数:", data.tags?.length || 0);

    return result;
  } catch (error) {
    const errorResult = { ...fallbackEnrich(item), coze_status: "failed", coze_error: error.message };
    errorResult.debug_coze_input = cozeInput;
    console.error("[Ark] 调用异常:", error.name, error.message);
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
    coze_status: "skipped",
  };
}

function mergeEnrichment(item, data = {}, cozeStatus) {
  const fallback = fallbackEnrich(item);
  const keyPoints = data.key_points || data.keyPoints || fallback.key_points;
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
  };

  Object.keys(properties).forEach((key) => properties[key] === undefined && delete properties[key]);

  let resp;
  try {
    resp = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.NOTION_API_KEY}`,
        "content-type": "application/json",
        "notion-version": env.NOTION_VERSION || "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties,
        children: notionChildren(item),
      }),
    });
  } catch (networkError) {
    // 网络错误（Notion 不可达等）：降级为 failed，不让整个收录流程崩溃
    const result = { status: "failed", error: `Notion 网络错误: ${networkError.message}` };
    if (item.debug_info) item.debug_info.phase4_notionResult = result;
    return result;
  }

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



function authorize(request, env) {
  if (!env.INGEST_TOKEN) return { ok: true };
  const auth = request.headers.get("authorization") || "";
  const apiKey = request.headers.get("x-api-key") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : apiKey;
  if (token === env.INGEST_TOKEN) return { ok: true };
  return { ok: false, error: "unauthorized" };
}

// fetch 带超时（毫秒）：外部 API 调用统一走这里，避免挂起
async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  if (Array.isArray(points)) return points.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 4);
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

function notionChildren(item) {
  const blocks = [];
  // ✅ 正文保留摘要（可读性好）
  blocks.push(paragraph(`摘要：${item.summary || ""}`));
  // ✅ 正文保留关键要点（便于扫读）
  if (item.key_points?.length) {
    blocks.push(heading2("关键要点"));
    for (const point of item.key_points.slice(0, 8)) blocks.push(bulleted(point));
  }
  // ✅ 正文摘录（折叠块，方便快速浏览时不占空间，展开可看原文前 1800 字）
  const raw = truncate(item.text || "", 1800);
  if (raw) {
    blocks.push(toggleBlock("📖 正文摘录（可折叠）", [paragraph(raw)]));
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

/**
 * 📱 Bark 推送通知：收录完成后推送到 iPhone
 * 用法：sendBarkNotification("key", result)
 */
async function sendBarkNotification(barkKey, result) {
  try {
    const title = result.title || "未知内容";
    const category = result.category || "未分类";
    const platform = result.source_platform || "";
    const cozeOk = result.coze_status === "ok";
    const notionOk = result.notion_status === "created";
    const notionUrl = result.notion_page_url || "";

    // 推送标题
    const pushTitle = notionOk ? "✅ 已收录" : "⚠️ 收录异常";
    // 推送内容
    let body = `${title}`;
    if (platform) body += `\n📱 ${platform}`;
    body += `\n🏷️ ${category}`;
    if (cozeOk) body += `\n🤖 AI分析完成`;
    else if (result.coze_status === "failed") body += `\n🤖 AI分析失败`;
    if (notionOk) body += `\n📝 Notion已创建`;
    if (result.jina_status) body += `\n🔗 ${result.jina_status}`;

    const url = `https://api.day.app/${barkKey}/${encodeURIComponent(pushTitle)}/${encodeURIComponent(body)}?group=知识库&icon=https://emojicdn.elk.sh/📚`;

    const resp = await fetch(url, { method: "GET" });
    console.log(`[Bark] 推送结果: ${resp.status}`);
    return resp.status;
  } catch (e) {
    console.error(`[Bark] 推送失败: ${e.message}`);
  }
}
