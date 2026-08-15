// ==================================================
// Chrome 扩展 popup 主逻辑
// ==================================================

// 全局变量
let pageEl, saveBtn, statusEl, optionsLink;

// 获取当前活动 tab
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
  console.log("✅ DOM加载完成");
  
  pageEl = document.querySelector("#page");
  saveBtn = document.querySelector("#save");
  statusEl = document.querySelector("#status");
  optionsLink = document.querySelector("#options");
  
  if (!saveBtn) {
    console.error("❌ 找不到保存按钮");
    return;
  }
  
  // 绑定收录按钮
  saveBtn.addEventListener("click", handleSave);
  
  // ✅ 绑定「插件设置」链接：打开options页
  if (optionsLink) {
    optionsLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  // 绑定「监控台」按钮
  const openAdminBtn = document.querySelector("#openAdmin");
  if (openAdminBtn) {
    openAdminBtn.addEventListener("click", async () => {
      const cfg = await chrome.storage.sync.get(["workerBaseUrl", "ingestToken"]);
      if (!cfg.workerBaseUrl || !cfg.ingestToken) {
        alert("请先在插件设置里填写 Worker URL 和 INGEST_TOKEN");
        return;
      }
      const base = String(cfg.workerBaseUrl).replace(/\/ingest\/?$/, "").replace(/\/$/, "");
      chrome.tabs.create({ url: `${base}/admin?token=${encodeURIComponent(cfg.ingestToken)}` });
    });
  }
  
  console.log("✅ popup.js 初始化完成");
});

// ==================================================
// 核心抓取逻辑：直接在这里处理，不绕弯
// ==================================================

async function handleSave() {
  console.log("🔘 点击了收录按钮");
  statusEl.textContent = "保存中...";
  
  try {
    const tab = await getCurrentTab();
    const pageUrl = tab.url || "";
    const pageTitle = tab.title || "";
    
    console.log("📄 页面信息:", { pageUrl, pageTitle });
    
    // ========== 直接注入脚本抓取，直接返回结果，再也不碰傻逼的storage！ ==========
    // ========== 通用抓取：Readability.js（Firefox Reader View同款）==========
    // 先注入 readability.js（把 Readability 类挂到页面 window），再跑提取脚本
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["readability.js"],
    });

    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        console.log("📝 抓取脚本开始（专精 + Readability 混合）");
        const pageUrl = window.location.href;
        const hostname = window.location.hostname;

        // ========== 平台专精 extractor：只做「元数据补全」，正文交给 Readability ==========
        // 目标：正文用业界最优的 Readability，author/published_at 走站点精准选择器
        function normalizeToISO(raw) {
          // 把各种中文/杂糅时间格式转成 ISO 8601，Notion 才认；转不了返回 ""
          if (!raw) return "";
          let s = String(raw).trim();
          // 去掉常见前缀
          s = s.replace(/^(发布于|编辑于|发表于|Published on|Posted on|updated on)\s*/i, "").trim();
          // 已经是 ISO？
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
          // 2026-03-13 12:08(:00)
          let m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
          if (m) {
            const [_, y, mo, d, h, mi, se] = m;
            const iso = `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi.padStart(2,'0')}:${(se||'00').padStart(2,'0')}+08:00`;
            return iso;
          }
          // 2026年3月13日 12:08
          m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s]*(\d{1,2}):(\d{1,2})/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5].padStart(2,'0')}:00+08:00`;
          // 2026年3月13日
          m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T00:00:00+08:00`;
          // 2026-03-13 纯日期
          m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T00:00:00+08:00`;
          return "";
        }

        function getMetaByPlatform() {
          const meta = { author: "", published_at: "", site_hint: "" };

          // ---- 知乎（专栏 zhuanlan.zhihu.com/p/xxx + 问答 zhihu.com/question/xxx/answer/xxx）----
          if (hostname.includes("zhihu.com")) {
            meta.site_hint = "知乎";
            // 作者：多种选择器兜底
            // 注意：不能用 meta[itemprop="name"]，那是问题标题而非答主
            let authorEl =
              document.querySelector('.AuthorInfo-name .UserLink-link') ||
              document.querySelector('.AuthorInfo .UserLink-link') ||
              document.querySelector('.Post-Author .UserLink-link') ||
              document.querySelector('.AuthorInfo-content .UserLink') ||
              document.querySelector('.QuestionAnswer-content .AuthorInfo-name a');
            // 🆕 兜底：找页面第一个 /people/ 链接（新版问答页 DOM class 变了）
            if (!authorEl) {
              const candidates = document.querySelectorAll('a[href*="/people/"]');
              for (const el of candidates) {
                const txt = (el.textContent || "").trim();
                if (txt && txt.length >= 2 && txt.length <= 30 &&
                    !el.closest('.Comments, .CommentPage, .RecommendedList')) {
                  authorEl = el;
                  break;
                }
              }
            }
            if (authorEl) meta.author = (authorEl.getAttribute("content") || authorEl.textContent || "").trim();
            // 发布时间：优先 meta，其次 time 元素
            const timeMeta =
              document.querySelector('meta[itemprop="datePublished"]') ||
              document.querySelector('meta[property="article:published_time"]');
            if (timeMeta) meta.published_at = normalizeToISO(timeMeta.getAttribute("content"));
            if (!meta.published_at) {
              // 知乎问答页：.ContentItem-time 里带 "发布于 2026-03-13 12:08" / "编辑于 xxx"
              // 优先 datetime 属性（标准 ISO），其次抓 data-tooltip / 文本
              const timeEl = document.querySelector('.ContentItem-time time') ||
                             document.querySelector('.ContentItem-time') ||
                             document.querySelector('[itemprop="dateCreated"]') ||
                             document.querySelector('time[datetime]') ||
                             document.querySelector('[data-tooltip*="发布"]');
              if (timeEl) {
                const raw = timeEl.getAttribute("datetime") ||
                            timeEl.getAttribute("data-tooltip") ||
                            timeEl.textContent || "";
                meta.published_at = normalizeToISO(raw);
              }
            }
          }
          // ---- 微信公众号 ----
          else if (hostname.includes("mp.weixin.qq.com")) {
            meta.site_hint = "微信公众号";
            const authorEl = document.querySelector('#js_name') ||
                             document.querySelector('.rich_media_meta_nickname') ||
                             document.querySelector('.profile_nickname');
            if (authorEl) meta.author = authorEl.textContent.trim();
            const timeEl = document.querySelector('#publish_time') ||
                           document.querySelector('em#publish_time') ||
                           document.querySelector('.rich_media_meta_text');
            meta.published_at = normalizeToISO(timeEl?.textContent);
          }
          // ---- 掘金 ----
          else if (hostname.includes("juejin.cn")) {
            meta.site_hint = "掘金";
            const authorEl = document.querySelector('.author-info-block .username .name') ||
                             document.querySelector('.author-name');
            if (authorEl) meta.author = authorEl.textContent.trim();
            const timeEl = document.querySelector('.meta-box time') || document.querySelector('time');
            if (timeEl) meta.published_at = normalizeToISO(timeEl.getAttribute("datetime") || timeEl.textContent);
          }
          // ---- 少数派 ----
          else if (hostname.includes("sspai.com")) {
            meta.site_hint = "少数派";
            const authorEl = document.querySelector('.user-info .username') ||
                             document.querySelector('.article__author .username');
            if (authorEl) meta.author = authorEl.textContent.trim();
            const timeEl = document.querySelector('.timer') || document.querySelector('time');
            if (timeEl) meta.published_at = normalizeToISO(timeEl.getAttribute("datetime") || timeEl.textContent);
          }

          // ---- 通用回退：Open Graph / JSON-LD 元数据 ----
          if (!meta.author) {
            const ogAuthor =
              document.querySelector('meta[property="article:author"]') ||
              document.querySelector('meta[name="author"]');
            if (ogAuthor) meta.author = ogAuthor.getAttribute("content") || "";
          }
          if (!meta.published_at) {
            const ogTime = document.querySelector('meta[property="article:published_time"]') ||
                           document.querySelector('meta[name="pubdate"]') ||
                           document.querySelector('meta[itemprop="datePublished"]');
            if (ogTime) meta.published_at = normalizeToISO(ogTime.getAttribute("content"));
          }
          // 🆕 兜底：所有平台都试一下页面里第一个带 datetime 的 <time>（很多站点都用这个）
          if (!meta.published_at) {
            const anyTime = document.querySelector('time[datetime]');
            if (anyTime) meta.published_at = normalizeToISO(anyTime.getAttribute("datetime"));
          }

          // 清理 author：去除后面的机构/职位/关注按钮文本（如"大狗狗是狼 南方科技大学 工学硕士 关注"→"大狗狗是狼"）
          if (meta.author) {
            meta.author = meta.author
              .replace(/\s*(关注|Follow|已关注|已认证)\s*$/g, "")
              .replace(/\n+/g, " ")
              .replace(/\s{2,}/g, " ")
              .trim();
            // 知乎特色：作者名后跟一堆机构头衔，用第一个空格切
            if (hostname.includes("zhihu.com")) {
              const parts = meta.author.split(/\s+/);
              if (parts.length > 1 && parts[0].length >= 2) {
                meta.author = parts[0];
              }
            }
          }
          return meta;
        }

        const platMeta = getMetaByPlatform();
        console.log("✅ 平台元数据:", platMeta);

        // 优先用户选中的文字（>= 30 字才当作有意义的选中）
        const selection = window.getSelection()?.toString()?.trim() || "";
        if (selection.length >= 30) {
          console.log("✅ 使用用户选中文字, 长度:", selection.length);
          return {
            text: selection,
            published_at: platMeta.published_at,
            author: platMeta.author,
            site_name: platMeta.site_hint,
            extractor: "selection",
          };
        }

        // 用 Readability 抓正文（克隆document，避免污染页面）
        let article = null;
        try {
          // 🆕 知乎问答页：挑「当前视口内可见面积最大」的 AnswerItem
          //    用户滚动到哪条 = 屏幕上看到哪条 = 就抓哪条（这是最直观的用户预期）
          let docClone;
          if (hostname.includes("zhihu.com")) {
            const answerCards = document.querySelectorAll(
              '[data-za-detail-view-path-module="AnswerItem"], .AnswerCard, .AnswerItem, .List-item'
            );

            let targetCard = null;
            if (answerCards.length > 0) {
              const vh = window.innerHeight;
              let bestArea = 0;
              for (const card of answerCards) {
                const rect = card.getBoundingClientRect();
                // 只统计跟视口有交集的部分
                const visibleTop = Math.max(0, rect.top);
                const visibleBottom = Math.min(vh, rect.bottom);
                const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                const visibleArea = visibleHeight * Math.max(0, rect.width);
                if (visibleArea > bestArea) {
                  bestArea = visibleArea;
                  targetCard = card;
                }
              }
              if (targetCard) {
                console.log(`🎯 [知乎] 挑中视口内占比最大的 AnswerItem (共 ${answerCards.length} 条候选)`);
              }
            }

            if (targetCard) {
              const parser = new DOMParser();
              const isolated = parser.parseFromString(
                `<!DOCTYPE html><html><head><title>${document.title}</title></head><body><article>${targetCard.outerHTML}</article></body></html>`,
                "text/html"
              );
              docClone = isolated;
            } else {
              console.log("⚠️ [知乎] 页面上没有 AnswerItem，退回全页 Readability");
              docClone = document.cloneNode(true);
            }
          } else {
            docClone = document.cloneNode(true);
          }

          article = new Readability(docClone, {
            charThreshold: 100,      // 最小字符阈值
            keepClasses: false,
          }).parse();
        } catch (e) {
          console.error("❌ Readability 解析异常:", e);
        }

        if (article && article.textContent && article.textContent.trim().length > 100) {
          console.log("✅ Readability 抓到正文长度:", article.textContent.length);
          console.log("   title:", article.title);
          console.log("   byline:", article.byline);
          console.log("   siteName:", article.siteName);
          console.log("   platMeta 优先:", platMeta);
          // ⭐ 平台专精 author/published_at 优先，Readability byline 作为兜底
          return {
            text: article.textContent.trim(),
            title: article.title || "",
            author: platMeta.author || article.byline || "",
            site_name: platMeta.site_hint || article.siteName || "",
            published_at: platMeta.published_at || "",
            extractor: platMeta.site_hint ? `${platMeta.site_hint}+readability` : "readability",
          };
        }

        // Readability 失败 → 兜底抓 <article>/<main>/body 的 innerText
        console.log("⚠️ Readability 未抓到，走 innerText 兜底");
        const fallbackEl = document.querySelector("article") ||
                           document.querySelector("main") ||
                           document.querySelector("[role='main']") ||
                           document.body;
        const fallbackText = (fallbackEl?.innerText || "").trim();
        console.log("✅ 兜底抓到长度:", fallbackText.length);
        return {
          text: fallbackText,
          published_at: platMeta.published_at,
          author: platMeta.author,
          site_name: platMeta.site_hint,
          extractor: "innertext",
        };
      },
    });
    
    // 直接从返回值拿
    const injected = injectionResult?.result || {};
    const selectedText = injected.text || "";
    const publishedAt = injected.published_at || "";
    const author = injected.author || "";
    const readabilityTitle = injected.title || "";
    const siteName = injected.site_name || "";
    const extractorUsed = injected.extractor || "unknown";

    // title 优先级：Readability 提取的 > 页面 tab.title
    let finalTitle = readabilityTitle || pageTitle;

    // 🧹 通用 title 清洗（不依赖平台白名单）
    // 1. 去掉浏览器通知计数前缀：(99+ 封私信 / 59 条消息)、(3)、(new message)等
    finalTitle = finalTitle.replace(/^\s*\(\d+\+?\s*[^\)]*\)\s*/, "");
    finalTitle = finalTitle.replace(/^\s*\(\d+\)\s*/, "");
    finalTitle = finalTitle.replace(/^\s*\((new|update|updated|hot|new message|新消息)[^\)]*\)\s*/i, "");
    // 2. 去掉常见的站点名后缀：" - 知乎"、" | Medium"、" - 掘金" 等
    finalTitle = finalTitle.replace(/\s*[-|_—·]\s*(知乎|微信.*|掘金|少数派|简书|CSDN|博客园|Medium|Substack)\s*$/i, "");
    finalTitle = finalTitle.trim();

    console.log("========== 最终抓取结果 ==========");
    console.log("✅ 抓取器:", extractorUsed);
    console.log("✅ 文本长度:", selectedText.length);
    console.log("✅ 前100字:", selectedText.slice(0, 100));
    console.log("✅ 标题:", finalTitle);
    console.log("✅ 作者:", author || "(空)");
    console.log("✅ 站点:", siteName || "(空)");
    console.log("================================");

    // ========== source_platform：通用抽取（hostname），不做平台白名单 ==========
    // 让 Coze/AI 端根据完整数据自行归类；这里只提供事实：hostname
    let sourcePlatform = "";
    try {
      const u = new URL(pageUrl);
      // 去掉 www. 前缀，保留裸域名（如 zhihu.com / mp.weixin.qq.com / news.sohu.com）
      sourcePlatform = u.hostname.replace(/^www\./, "");
      // Readability 抓到的 siteName 更适合展示时优先用（如"少数派"、"知乎专栏"）
      if (siteName) sourcePlatform = siteName;
    } catch (e) {
      sourcePlatform = "";
    }
    console.log("✅ source_platform:", sourcePlatform);

    // ========== 最终传给Coze的完整数据，在这里直接打印方便调试！ ==========
    const finalPayload = {
      title: finalTitle,
      text: selectedText,
      source_platform: sourcePlatform,
      source_url: pageUrl,
      content_type: "article",
      capture_device: "chrome-extension",
      published_at: publishedAt,  // ✅ 发布时间的ISO格式
      author: author,              // ✅ 知乎作者名
    };
    
    console.log("\n");
    console.log("=".repeat(80));
    console.log("📤 最终要传给Coze的完整数据：");
    console.log("=".repeat(80));
    console.log(JSON.stringify(finalPayload, null, 2));
    console.log("=".repeat(80));
    console.log("\n");
    
    // ========== 异步模式：把任务丢给background，Popup立刻结束loading ==========
    // background拿到后台队列处理，完成/失败都用系统通知反馈
    // 好处：Popup关不关都无所谓，切页面也没事，网络慢也不影响
    console.log("📤 正在发送异步收录任务给background，文本长度:", selectedText.length);
    
    const result = await chrome.runtime.sendMessage({
      type: "QUEUE_SAVE_CURRENT_PAGE",  // ← 异步队列类型（background.js 已支持）
      tab: { url: pageUrl, title: pageTitle },
      selectionText: selectedText,
      publishedAt: publishedAt,
      author: author,
      captureMode: "popup",
    });
    
    console.log("📥 background返回（任务已入队）:", result);
    
    if (result?.ok && result?.queued) {
      // ✅ 已提交给 background，background 会等 Worker 同步处理完后弹系统通知
      statusEl.innerHTML = '<span class="ok">⏳ 正在收录中，完成后弹系统通知…</span>';
      // 不再setTimeout自动关闭，让用户自然点走或忽略
      // Popup切到别处或点别处会自然消失，不切也不影响background
    } else {
      statusEl.innerHTML = `<span class="err">❌ 提交失败：${result?.error || "未知错误"}</span>`;
    }
  } catch (err) {
    console.error("💥 收录异常:", err);
    statusEl.innerHTML = `<span class="err">❌ 异常：${err?.message || String(err)}</span>`;
  } finally {
    // saveBtn 是模块顶部 DOMContentLoaded 里绑定的按钮，用它禁用
    const saveBtnEl = document.getElementById("saveBtn");
    if (saveBtnEl) saveBtnEl.disabled = false;
  }
}

