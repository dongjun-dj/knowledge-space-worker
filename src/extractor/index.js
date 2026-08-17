import { renderApp } from "./ui.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(renderApp(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "knowledge-extractor",
        configured: {
          api_token: Boolean(env.API_TOKEN),
          tikhub: Boolean(env.TIKHUB_TOKEN),
        },
      });
    }

    if (url.pathname !== "/extract" || request.method !== "POST") {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (!env.API_TOKEN) {
      return json({ ok: false, error: "Server API_TOKEN is not configured" }, 503);
    }
    if (!safeTokenEqual(request.headers.get("authorization"), `Bearer ${env.API_TOKEN}`)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    try {
      const input = await request.json();
      const sourceUrl = validateSourceUrl(input.url);
      const platform = detectPlatform(sourceUrl);
      const content = await extract(sourceUrl, platform, env);
      const document = normalizeDocument(content, sourceUrl, platform);
      const format = input.format === "markdown" ? "markdown" : "json";

      if (format === "markdown") {
        return new Response(toMarkdown(document), {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            ...corsHeaders(request, env),
          },
        });
      }

      return json(
        { ok: true, status: "extracted", document, markdown: toMarkdown(document) },
        200,
        corsHeaders(request, env),
      );
    } catch (error) {
      const status = error.status || 500;
      return json(
        { ok: false, error: error.message || "Extraction failed" },
        status,
        corsHeaders(request, env),
      );
    }
  },
};

export function detectPlatform(input) {
  const host = new URL(input).hostname.toLowerCase();
  if (
    host === "xhslink.com"
    || host.endsWith(".xhslink.com")
    || host === "xhslink.cn"
    || host.endsWith(".xhslink.cn")
    || host.endsWith(".xiaohongshu.com")
  ) {
    return "xiaohongshu";
  }
  if (host === "b23.tv" || host.endsWith(".bilibili.com")) return "bilibili";
  if (host === "zhihu.com" || host.endsWith(".zhihu.com")) return "zhihu";
  if (
    host === "douyin.com"
    || host.endsWith(".douyin.com")
    || host === "iesdouyin.com"
    || host.endsWith(".iesdouyin.com")
  ) {
    return "douyin";
  }
  if (
    host === "weibo.com"
    || host.endsWith(".weibo.com")
    || host === "weibo.cn"
    || host.endsWith(".weibo.cn")
  ) {
    return "weibo";
  }
  throw httpError(400, "Only Xiaohongshu, Bilibili, Zhihu, Douyin and Weibo URLs are supported");
}

function validateSourceUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw httpError(400, "A valid url is required");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw httpError(400, "Invalid URL");
  }
  if (url.protocol === "http:" && /(^|\.)xhslink\.(cn|com)$/i.test(url.hostname)) {
    url.protocol = "https:";
  }
  if (url.protocol !== "https:") throw httpError(400, "Only HTTPS URLs are allowed");
  detectPlatform(url.toString());
  return url.toString();
}

async function extract(url, platform, env) {
  if (platform === "xiaohongshu") return extractXiaohongshu(url, env);
  if (platform === "bilibili") return extractBilibili(url, env);
  if (platform === "zhihu") return extractZhihu(url, env);
  if (platform === "douyin") return extractDouyin(url, env);
  if (platform === "weibo") return extractWeibo(url, env);
  throw httpError(400, `Unsupported platform: ${platform}`);
}
export { extract, normalizeDocument };

async function extractXiaohongshu(url, env) {
  if (!env.TIKHUB_TOKEN) {
    throw httpError(503, "Xiaohongshu extraction requires TIKHUB_TOKEN");
  }
  // 先用图文接口提取（也能返回视频笔记的基本信息）
  const endpoint = new URL("https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_image_note_detail");
  endpoint.searchParams.set("share_text", url);
  const payload = await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
  });
  const data = unwrap(payload);
  const note = data?.[0]?.note_list?.[0]
    || findObject(data, ["note", "note_card", "item", "data"])
    || data;

  // 检测是否是视频笔记，如果是则调 video 接口拿字幕
  const noteType = note?.type || "";
  let subtitleText = "";
  if (noteType === "video") {
    try {
      const videoEndpoint = new URL("https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_video_note_detail");
      videoEndpoint.searchParams.set("share_text", url);
      const videoPayload = await fetchJson(videoEndpoint, {
        headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
      });
      const videoData = unwrap(videoPayload);
      // video 接口返回结构：[{note对象直接在数组里}]
      const videoNote = Array.isArray(videoData) ? videoData[0] : videoData;
      // 提取中文字幕 SRT
      const subtitles = videoNote?.video_info_v2?.media?.video?.subtitles;
      if (subtitles) {
        const zhSub = subtitles["zh-CN"]?.[0] || subtitles["source"]?.[0];
        if (zhSub?.url) {
          const srtResp = await fetch(zhSub.url);
          const srtText = await srtResp.text();
          // SRT 转纯文本：去掉序号和时间轴，合并碎片句
          const rawLines = srtText
            .split('\n')
            .filter(line => !line.match(/^\d+$/) && !line.match(/^\d{2}:\d{2}:\d{2}/) && line.trim());
          subtitleText = cleanTextLines(rawLines);
        }
      }
    } catch (e) {
      console.log(`[XHS-Video] 字幕提取失败: ${e.message}`);
    }
  }

  const noteImages = Array.isArray(note?.images_list)
    ? note.images_list
      .map((image) => image.original || image.url_size_large || image.url)
      .filter(Boolean)
    : deepImageUrls(note);

  const body = firstString(note, ["desc", "content", "description", "note_content"]) || "";
  // 视频字幕追加到正文后面
  const fullBody = subtitleText ? `${body}\n\n## 🎬 视频字幕\n${subtitleText}` : body;

  return {
    title: firstString(note, ["title", "display_title", "note_title"]) || "小红书笔记",
    author: deepFirstString(note, ["nickname", "name", "user_name"]),
    publishedAt: timestampToIso(deepFirst(note, ["time", "create_time", "publish_time"])),
    body: fullBody,
    images: noteImages,
    raw: data,
  };
}

async function extractBilibili(inputUrl, env) {
  const resolved = await resolveKnownShortUrl(inputUrl);
  const bvid = resolved.match(/\/video\/(BV[a-zA-Z0-9]+)/i)?.[1];
  if (!bvid) throw httpError(400, "Could not find a Bilibili BV id in the URL");

  let view;
  try {
    view = unwrap(await fetchJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { headers: { referer: resolved, "user-agent": "Mozilla/5.0" } },
    ));
  } catch (officialError) {
    if (!env.TIKHUB_TOKEN) {
      throw httpError(502, "Bilibili blocked the server request and TikHub fallback is not configured");
    }
    const detailEndpoint = new URL("https://api.tikhub.io/api/v1/bilibili/web/fetch_one_video");
    detailEndpoint.searchParams.set("bv_id", bvid);
    view = unwrap(await fetchJson(detailEndpoint, {
      headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
    }));
  }
  const page = view.pages?.[0];
  const cid = page?.cid || view.cid;
  if (!cid || !view.aid) throw httpError(502, "Bilibili video detail did not return aid/cid");

  let subtitleData;
  try {
    const player = unwrap(await fetchJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      { headers: { referer: resolved, "user-agent": "Mozilla/5.0" } },
    ));
    subtitleData = player.subtitle;
  } catch {
    subtitleData = null;
  }

  if ((!subtitleData?.subtitles?.length) && env.TIKHUB_TOKEN) {
    const endpoint = new URL("https://api.tikhub.io/api/v1/bilibili/web/fetch_video_subtitle");
    endpoint.searchParams.set("a_id", String(view.aid));
    endpoint.searchParams.set("c_id", String(cid));
    subtitleData = unwrap(await fetchJson(endpoint, {
      headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
    }));
  }

  const tracks = subtitleData?.subtitles || subtitleData?.subtitle || deepFirst(subtitleData, ["subtitles"]);
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw httpError(422, "This Bilibili video has no accessible platform subtitles");
  }
  const track = tracks.find((item) => /zh|中文|ai-zh/i.test(`${item.lan || ""} ${item.lan_doc || ""}`)) || tracks[0];
  let subtitleUrl = track.subtitle_url || track.url;
  if (subtitleUrl?.startsWith("//")) subtitleUrl = `https:${subtitleUrl}`;
  const subtitle = await fetchJson(subtitleUrl);
  const transcript = (subtitle.body || subtitle.data?.body || []).map((line) => ({
    start: Number(line.from ?? line.start ?? 0),
    end: Number(line.to ?? line.end ?? 0),
    text: String(line.content ?? line.text ?? "").trim(),
  })).filter((line) => line.text);

  return {
    title: view.title,
    author: view.owner?.name,
    publishedAt: timestampToIso(view.pubdate),
    body: view.desc,
    transcript,
    videoId: bvid,
    durationSeconds: page?.duration || view.duration,
    images: view.pic ? [view.pic] : [],
  };
}

async function extractZhihu(url, env) {
  try {
    const response = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
      headers: { accept: "text/plain", "user-agent": "knowledge-extractor/0.1" },
    }, 8000);
    if (!response.ok) throw new Error(`Jina Reader failed (${response.status})`);
    const text = await response.text();
    if (!text.trim()) throw new Error("Jina Reader returned empty content");
    const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
      || text.match(/^#\s+(.+)$/m)?.[1]?.trim()
      || "知乎内容";
    return { title, body: text.trim(), author: "", publishedAt: "" };
  } catch (jinaError) {
    if (!env.TIKHUB_TOKEN) throw httpError(502, jinaError.message);
  }

  const parsed = new URL(url);
  const answerId = parsed.pathname.match(/\/answer\/(\d+)/)?.[1];
  const articleId = parsed.pathname.match(/\/p\/(\d+)/)?.[1];
  let endpoint;
  if (answerId) {
    endpoint = new URL("https://api.tikhub.io/api/v1/zhihu/web/fetch_answer_detail");
    endpoint.searchParams.set("answer_id", answerId);
  } else if (articleId) {
    endpoint = new URL("https://api.tikhub.io/api/v1/zhihu/web/fetch_column_article_detail");
    endpoint.searchParams.set("article_id", articleId);
  } else {
    throw httpError(400, "TikHub fallback currently supports Zhihu answers and column articles");
  }

  const data = unwrap(await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
  }));
  const item = findObject(data, ["answer", "article", "data", "item"]) || data;
  const html = firstString(item, ["content", "excerpt", "description"]);
  return {
    title: item.question?.title
      || firstString(item, ["title", "question_title"])
      || deepFirstString(item, ["title", "name"])
      || "知乎内容",
    author: deepFirstString(item.author || item, ["name", "nickname"]),
    publishedAt: timestampToIso(deepFirst(item, ["created_time", "created", "updated_time"])),
    body: htmlToText(html),
    images: deepImageUrls(item),
  };
}

async function extractDouyin(url, env) {
  if (!env.TIKHUB_TOKEN) {
    throw httpError(503, "Douyin extraction requires TIKHUB_TOKEN");
  }
  // 短链（v.douyin.com / iesdouyin.com）需要 follow 重定向拿真实 URL
  let shareUrl = url;
  const host = new URL(url).hostname.toLowerCase();
  if (host === "v.douyin.com" || host.endsWith(".v.douyin.com") || host.endsWith("iesdouyin.com")) {
    try {
      const resp = await fetch(url, { redirect: "follow" });
      if (resp.url && resp.url !== url) shareUrl = resp.url;
    } catch (e) {
      console.log(`[Douyin] 短链解析失败: ${e.message}`);
    }
  }

  const endpoint = new URL("https://api.tikhub.io/api/v1/douyin/web/fetch_one_video_by_share_url");
  endpoint.searchParams.set("share_url", shareUrl);
  const payload = await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
  });
  const data = unwrap(payload);
  const aweme = findObject(data, ["aweme_detail", "aweme", "item"]) || data;

  const desc = firstString(aweme, ["desc", "description", "content"]) || "";
  const authorInfo = aweme?.author || aweme?.user || {};

  // 图集类型：提取图片 URL
  const images = Array.isArray(aweme?.images)
    ? aweme.images.flatMap((img) => {
      if (typeof img === "string") return [img];
      const urlList = img?.url_list || [];
      return urlList.length ? [urlList[urlList.length - 1]] : [img?.url].filter(Boolean);
    })
    : [];
  // 视频封面作为补充
  if (images.length === 0) {
    const cover = aweme?.video?.cover?.url_list?.[0] || aweme?.video?.cover?.url;
    if (cover) images.push(cover);
  }

  return {
    title: desc.split("\n")[0]?.trim() || "抖音视频",
    author: firstString(authorInfo, ["nickname", "name", "unique_id"]),
    publishedAt: timestampToIso(aweme?.create_time),
    body: desc,
    images,
    raw: data,
  };
}

async function extractWeibo(url, env) {
  if (!env.TIKHUB_TOKEN) {
    throw httpError(503, "Weibo extraction requires TIKHUB_TOKEN");
  }
  // 从 URL path 最后一部分提取 post_id
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const postId = segments[segments.length - 1];
  if (!postId) {
    throw httpError(400, "Could not extract Weibo post id from URL");
  }

  // 用 v1 接口（v2 接口不稳定，经常返回 Request failed）
  const endpoint = new URL("https://api.tikhub.io/api/v1/weibo/web/fetch_post_detail");
  endpoint.searchParams.set("post_id", postId);
  const payload = await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${env.TIKHUB_TOKEN}` },
  });
  // v1 返回结构：payload.data.data（嵌套两层 data）
  const data = unwrap(payload);
  const post = findObject(data, ["mblog", "post"]) || data?.data || data;

  // 长微博优先用 longText，否则用短文本
  let fullText = "";
  const longText = firstString(post, ["longText", "long_text_content"]);
  if (longText) {
    fullText = htmlToText(longText);
  } else {
    fullText = htmlToText(firstString(post, ["text", "content", "description", "raw_text"]));
  }

  // 提取图片
  const images = [];
  // pic_ids + original_pic：从 pic_ids 构造图片 URL
  const picIds = post?.pic_ids;
  if (Array.isArray(picIds) && picIds.length > 0) {
    for (const pid of picIds) {
      if (typeof pid === "string") {
        images.push(`https://wx1.sinaimg.cn/large/${pid}.jpg`);
      }
    }
  }
  // pics 数组（v2 格式）
  const pics = post?.pics;
  if (Array.isArray(pics) && pics.length > 0 && images.length === 0) {
    for (const pic of pics) {
      const imgUrl = typeof pic === "string" ? pic : (pic?.large?.url || pic?.original?.url || pic?.url || "");
      if (imgUrl) images.push(imgUrl);
    }
  }
  // original_pic 兜底
  if (images.length === 0 && post?.original_pic) {
    images.push(post.original_pic);
  }

  const userInfo = post?.user || {};
  // 微博 created_at 可能是字符串（如 "Wed Aug 05 10:00:00 +0800 2026"）或时间戳
  const createdAt = post?.created_at;
  let publishedAt = "";
  if (typeof createdAt === "number") {
    publishedAt = timestampToIso(createdAt);
  } else if (typeof createdAt === "string" && createdAt) {
    const parsedDate = new Date(createdAt);
    publishedAt = isNaN(parsedDate.getTime()) ? createdAt : parsedDate.toISOString();
  }

  return {
    title: fullText.split("\n")[0]?.slice(0, 50).trim() || "微博内容",
    author: firstString(userInfo, ["screen_name", "name", "nickname"]),
    publishedAt,
    body: fullText,
    images,
    raw: data,
  };
}

function normalizeDocument(content, source, platform) {
  return {
    title: content.title || "未命名内容",
    source,
    platform,
    author: content.author || null,
    published_at: content.publishedAt || null,
    captured_at: new Date().toISOString(),
    content_type: content.transcript ? "video_transcript" : "article",
    video_id: content.videoId || null,
    duration_seconds: content.durationSeconds || null,
    body: content.body || "",
    transcript: content.transcript || [],
    images: [...new Set(content.images || [])],
  };
}

export function toMarkdown(doc) {
  const yaml = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `source: ${yamlString(doc.source)}`,
    `platform: ${doc.platform}`,
    `author: ${yamlString(doc.author || "")}`,
    `published_at: ${yamlString(doc.published_at || "")}`,
    `captured_at: ${yamlString(doc.captured_at)}`,
    `content_type: ${doc.content_type}`,
    ...(doc.video_id ? [`video_id: ${yamlString(doc.video_id)}`] : []),
    ...(doc.duration_seconds ? [`duration_seconds: ${doc.duration_seconds}`] : []),
    "---",
  ].join("\n");
  // 字幕预处理：去时间戳 + 合并碎片句 + 超长截断
  const transcript = doc.transcript.length
    ? `\n\n## 字幕\n\n${cleanTranscript(doc.transcript)}`
    : "";
  const images = doc.images.length
    ? `\n\n## 图片\n\n${doc.images.map((url) => `- ${url}`).join("\n")}`
    : "";
  return `${yaml}\n\n# ${doc.title}\n\n${doc.body || ""}${transcript}${images}\n`;
}

async function resolveKnownShortUrl(input) {
  const host = new URL(input).hostname;
  if (host !== "b23.tv") return input;
  // b23.tv 短链：手动跟随最多 5 次重定向
  let currentUrl = input;
  for (let i = 0; i < 5; i++) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });
    const location = response.headers.get("location");
    if (!location) {
      return currentUrl;
    }
    currentUrl = new URL(location, currentUrl).toString();
    if (/bilibili\.com\/video\/BV/i.test(currentUrl)) {
      return currentUrl;
    }
  }
  return currentUrl;
}

async function fetchJson(input, init = {}) {
  const response = await fetch(input, init);
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw httpError(502, `Upstream returned non-JSON (${response.status})`);
  }
  if (!response.ok) throw httpError(502, `Upstream request failed (${response.status})`);
  if (typeof value?.code === "number" && value.code !== 0 && value.code !== 200) {
    throw httpError(502, value.message || value.message_zh || `Upstream error ${value.code}`);
  }
  return value;
}

async function fetchWithTimeout(input, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unwrap(value) {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    if (current && typeof current === "object" && current.data != null) current = current.data;
    else break;
  }
  return current;
}

function findObject(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (value[key] && typeof value[key] === "object") return value[key];
  return null;
}

function firstString(object, keys) {
  for (const key of keys) if (typeof object?.[key] === "string" && object[key].trim()) return object[key].trim();
  return "";
}

function deepFirst(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) if (value[key] != null) return value[key];
  for (const child of Object.values(value)) {
    const found = deepFirst(child, keys);
    if (found != null) return found;
  }
  return undefined;
}

function deepFirstString(value, keys) {
  const found = deepFirst(value, keys);
  return typeof found === "string" ? found : "";
}

function deepImageUrls(value, output = []) {
  if (!value || typeof value !== "object" || output.length >= 30) return output;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^https?:\/\//.test(child) && /image|url|origin|default|master/i.test(key)) {
      if (/\.(jpe?g|png|webp)(\?|$)/i.test(child) || /xhscdn|sns-webpic/i.test(child)) output.push(child);
    } else if (child && typeof child === "object") deepImageUrls(child, output);
  }
  return [...new Set(output)];
}

function timestampToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number > 1e12 ? number : number * 1000).toISOString();
}

function yamlString(value) {
  return JSON.stringify(String(value).replace(/\r?\n/g, " "));
}

function safeTokenEqual(actual, expected) {
  if (!actual || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i += 1) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGIN;
  return {
    "access-control-allow-origin": allowed && origin === allowed ? origin : "null",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/**
 * 字幕预处理：去时间戳 + 保留原始断句换行 + 超长截断
 * 不合并句子 -- LLM 对"无标点但有换行"的理解远好于"无标点无换行的一整段"
 */
function cleanTranscript(transcript) {
  const lines = transcript.map((line) => line.text || "").filter(Boolean);
  return cleanTextLines(lines);
}

/**
 * 保留原始断句换行，不合并，只做超长截断
 */
function cleanTextLines(lines) {
  const maxChars = 8000;
  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + "\n\n...(字幕过长，已截断)";
  }
  return result;
}
