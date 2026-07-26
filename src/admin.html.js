// 监控台前端：单个 HTML，Alpine.js + Tailwind CDN，深色主题
// 通过 import 到 worker.js 里作为字符串返回
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KB 监控台 · Knowledge Space</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
<style>
  body { background: #0a0a0f; color: #e5e5e5; font-family: -apple-system, "SF Pro", "PingFang SC", sans-serif; }
  .card { background: #14141c; border: 1px solid #24242e; }
  .card:hover { background: #1a1a24; }
  .badge-ok { background: #0d3320; color: #4ade80; }
  .badge-partial { background: #3a2e0d; color: #facc15; }
  .badge-error { background: #3d0d0d; color: #f87171; }
  .badge-blocked { background: #3d0d0d; color: #f87171; }
  .badge-recovered { background: #0d2a33; color: #22d3ee; }
  .badge-neutral { background: #1e293b; color: #94a3b8; }
  .code-block {
    background: #0a0a10;
    color: #d4d4d8;
    padding: 12px;
    border-radius: 6px;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 12px;
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    border: 1px solid #24242e;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }
  .tab-btn { padding: 6px 14px; border-radius: 6px; font-size: 13px; transition: all 0.15s; cursor: pointer; }
  .tab-btn.active { background: #4f46e5; color: white; }
  .tab-btn:not(.active) { color: #94a3b8; }
  .tab-btn:not(.active):hover { background: #1e1e28; color: #e5e5e5; }
</style>
</head>
<body x-data="app()" x-init="init()" class="min-h-screen">
  <!-- 顶部栏 -->
  <div class="border-b border-gray-800 sticky top-0 z-10 backdrop-blur-md" style="background: rgba(10, 10, 15, 0.85)">
    <div class="max-w-7xl mx-auto px-6 py-3 flex items-center gap-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: linear-gradient(135deg, #6366f1, #8b5cf6)">
          <span class="text-white text-sm font-bold">K</span>
        </div>
        <div>
          <h1 class="text-lg font-semibold tracking-tight">KB 监控台</h1>
          <p class="text-xs text-gray-500">Knowledge Space</p>
        </div>
      </div>
      <!-- View 切换 -->
      <div class="flex gap-1 ml-4">
        <button @click="view='logs'; refresh()" :class="view==='logs'?'active':''" class="tab-btn">📋 收录日志</button>
        <button @click="view='queue'; refresh()" :class="view==='queue'?'active':''" class="tab-btn">
          ⏳ 待处理队列
          <span x-show="queuePendingCount > 0" x-text="'(' + queuePendingCount + ')'" class="ml-1 text-red-400 font-semibold"></span>
        </button>
      </div>

      <div class="flex-1"></div>
      <div class="flex items-center gap-2 max-w-md">
        <input
          x-show="view==='logs'"
          x-model="searchQ"
          @input.debounce.400ms="refresh()"
          placeholder="搜索 URL / 标题 / 平台…"
          class="w-64 px-3 py-1.5 rounded-md bg-gray-900 border border-gray-700 focus:border-indigo-500 focus:outline-none text-sm placeholder-gray-500"
        />
      </div>
      <select
        x-show="view==='logs'"
        x-model="statusFilter"
        @change="refresh()"
        class="px-3 py-1.5 rounded-md bg-gray-900 border border-gray-700 text-sm focus:outline-none focus:border-indigo-500"
      >
        <option value="">全部状态</option>
        <option value="ok">✓ 成功</option>
        <option value="recovered">🔵 Wayback 救回</option>
        <option value="blocked">🚫 登录墙</option>
        <option value="partial">⚠ 部分</option>
        <option value="error">✗ 失败</option>
      </select>
      <label class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
        <input type="checkbox" x-model="autoRefresh" class="accent-indigo-500" />
        自动
      </label>
      <button @click="refresh()" class="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition">
        <span x-show="!loading">刷新</span>
        <span x-show="loading">…</span>
      </button>
    </div>
    <!-- 统计条 -->
    <div class="max-w-7xl mx-auto px-6 pb-3 flex gap-2 text-xs">
      <template x-for="s in stats" :key="s.status">
        <div class="px-2.5 py-1 rounded-md" :class="{
          'badge-ok': s.status === 'ok',
          'badge-partial': s.status === 'partial',
          'badge-error': s.status === 'error',
          'badge-blocked': s.status === 'blocked',
          'badge-recovered': s.status === 'recovered',
          'badge-neutral': !['ok','partial','error','blocked','recovered'].includes(s.status)
        }">
          <span x-text="s.status"></span>: <b x-text="s.cnt"></b>
        </div>
      </template>
    </div>
  </div>

  <!-- 主内容：日志 View -->
  <div x-show="view==='logs'" class="max-w-7xl mx-auto px-6 py-6">
    <div x-show="!logs.length && !loading" class="text-center text-gray-500 py-16">
      <p class="text-sm">暂无记录。发起一次 /ingest 请求就会显示在这里。</p>
    </div>
    <div x-show="loading && !logs.length" class="text-center text-gray-500 py-16">
      <p class="text-sm animate-pulse">加载中…</p>
    </div>
    <div class="space-y-2">
      <template x-for="log in logs" :key="log.id">
        <div class="card rounded-lg overflow-hidden transition-colors">
          <div @click="toggle(log.id)" class="p-3 cursor-pointer flex items-center gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-medium shrink-0" :class="{
              'badge-ok': log.status === 'ok',
              'badge-partial': log.status === 'partial',
              'badge-error': log.status === 'error',
              'badge-blocked': log.status === 'blocked',
              'badge-recovered': log.status === 'recovered'
            }" x-text="statusLabel(log.status)"></span>
            <span class="text-xs text-gray-400 shrink-0 min-w-[60px]" x-text="log.source_platform || '—'"></span>
            <span class="text-xs shrink-0" :class="{
              'text-blue-400': log.capture_device === 'chrome-extension',
              'text-emerald-400': log.capture_device === 'ios',
              'text-gray-500': !['chrome-extension','ios'].includes(log.capture_device)
            }" x-text="deviceLabel(log.capture_device)"></span>
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate" x-text="log.title || log.source_url"></p>
              <p class="text-xs text-gray-500 truncate" x-text="log.source_url"></p>
            </div>
            <span x-show="log.jina_status" class="text-xs text-gray-500 shrink-0 hidden md:block" x-text="'Jina: ' + (log.jina_text_length || 0) + '字'"></span>
            <span class="text-xs text-gray-500 shrink-0" x-text="fmtTime(log.created_at)"></span>
            <span class="text-gray-500 text-xs" x-text="expanded[log.id] ? '▼' : '▶'"></span>
          </div>

          <div x-show="expanded[log.id]" x-transition class="border-t border-gray-800 p-4 space-y-4">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div><span class="text-gray-500">Request ID</span><br><span class="font-mono" x-text="log.request_id"></span></div>
              <div><span class="text-gray-500">耗时</span><br><span x-text="log.duration_ms + ' ms'"></span></div>
              <div><span class="text-gray-500">Jina</span><br><span x-text="log.jina_status || '未触发'"></span></div>
              <div><span class="text-gray-500">Notion</span><br>
                <a x-show="log.notion_page_url" :href="log.notion_page_url" target="_blank" class="text-indigo-400 hover:underline" x-text="log.notion_status || '—'"></a>
                <span x-show="!log.notion_page_url" x-text="log.notion_status || '—'"></span>
              </div>
            </div>

            <div x-show="log.status === 'blocked'" class="p-3 rounded bg-red-950 border border-red-900 text-red-300 text-xs">
              🚫 <b>命中登录墙/验证页</b>：Jina Reader 抓到的是拦截页而非正文。iOS 场景已自动入队"待处理队列"，回桌面 Chrome 一键消费。
            </div>
            <div x-show="log.status === 'recovered'" class="p-3 rounded bg-cyan-950 border border-cyan-900 text-cyan-300 text-xs">
              🔵 <b>Wayback Machine 救回</b>：原页面被拦截，从 archive.org 历史快照拿到了正文。
            </div>
            <div x-show="log.error" class="p-3 rounded bg-red-950 border border-red-900 text-red-300 text-xs">
              <b>❌ 错误：</b><span x-text="log.error"></span>
            </div>
            <div x-show="log.coze_error" class="p-3 rounded bg-orange-950 border border-orange-900 text-orange-300 text-xs">
              <b>⚠️ Coze错误：</b><span x-text="log.coze_error"></span>
            </div>
            <div x-show="log.notion_error" class="p-3 rounded bg-yellow-950 border border-yellow-900 text-yellow-300 text-xs">
              <b>⚠️ Notion错误：</b><span x-text="log.notion_error"></span>
            </div>

            <div>
              <div class="flex gap-1 mb-2 border-b border-gray-800 flex-wrap">
                <button @click="tabs[log.id]='raw'" :class="tabs[log.id]==='raw'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">收到 payload</button>
                <button @click="tabs[log.id]='coze_in'" :class="tabs[log.id]==='coze_in'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">送 Coze 的字段 ⭐</button>
                <button @click="tabs[log.id]='coze_out'" :class="tabs[log.id]==='coze_out'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">Coze 返回</button>
              </div>

              <div x-show="!tabs[log.id] || tabs[log.id]==='raw'">
                <div class="code-block" x-text="pretty(log.raw_payload)"></div>
              </div>
              <div x-show="tabs[log.id]==='coze_in'">
                <div class="code-block" x-text="pretty(log.coze_input)"></div>
              </div>
              <div x-show="tabs[log.id]==='coze_out'">
                <div class="code-block" x-text="pretty(log.coze_output)"></div>
              </div>
            </div>

            <div class="flex gap-2 text-xs">
              <button @click="copyJson(log.coze_input)" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">复制 Coze 输入</button>
              <a x-show="log.source_url" :href="log.source_url" target="_blank" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">🔗 打开原文</a>
              <a x-show="log.notion_page_url" :href="log.notion_page_url" target="_blank" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-indigo-400">→ 打开 Notion</a>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- 主内容：队列 View -->
  <div x-show="view==='queue'" class="max-w-7xl mx-auto px-6 py-6">
    <div class="mb-4 p-4 rounded-lg bg-indigo-950 border border-indigo-900 text-sm text-indigo-200">
      <p class="font-medium mb-1">📱 待处理队列说明</p>
      <p class="text-xs text-indigo-300">手机端（iOS 快捷指令）遇到登录墙/反爬时，Worker 会自动把 URL 入队。回桌面后打开对应 URL，用 Chrome 插件一键收录即可完成入库。</p>
    </div>

    <div x-show="!queue.length && !loading" class="text-center text-gray-500 py-16">
      <p class="text-sm">队列为空 ✓</p>
    </div>

    <div class="space-y-2">
      <template x-for="q in queue" :key="q.id">
        <div class="card rounded-lg p-4">
          <div class="flex items-start gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-medium shrink-0 mt-0.5" :class="{
              'badge-blocked': q.reason && q.reason.startsWith('blocked'),
              'badge-error': q.reason === 'jina_error',
              'badge-neutral': !q.reason || (!q.reason.startsWith('blocked') && q.reason !== 'jina_error')
            }" x-text="reasonLabel(q.reason)"></span>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium truncate" x-text="q.title || '(无标题)'"></p>
              <a :href="q.source_url" target="_blank" class="text-xs text-indigo-400 hover:underline break-all" x-text="q.source_url"></a>
              <p class="text-xs text-gray-500 mt-1">
                <span x-text="deviceLabel(q.capture_device)"></span> · <span x-text="fmtTime(q.created_at)"></span>
              </p>
            </div>
            <div class="flex gap-2 shrink-0">
              <button @click="copyUrl(q.source_url)" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs">复制 URL</button>
              <a :href="q.source_url" target="_blank" class="px-2.5 py-1 rounded bg-indigo-800 hover:bg-indigo-700 text-white text-xs">🌐 打开去收录</a>
              <button @click="markConsumed(q.id)" class="px-2.5 py-1 rounded bg-green-800 hover:bg-green-700 text-white text-xs">✓ 已收录</button>
              <button @click="abandonItem(q.id)" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-red-800 text-gray-400 hover:text-white text-xs">✗ 放弃</button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div x-show="loading" class="text-center text-gray-500 py-8"><p class="text-sm animate-pulse">加载中…</p></div>
  </div>

<script>
function app() {
  return {
    view: "logs",
    logs: [],
    queue: [],
    stats: [],
    queuePendingCount: 0,
    expanded: {},
    tabs: {},
    loading: false,
    autoRefresh: false,
    autoTimer: null,
    statusFilter: "",
    searchQ: "",
    token: new URLSearchParams(location.search).get("token") || "",

    init() {
      this.refresh();
      this.refreshQueueCount();
      this.$watch("autoRefresh", (v) => {
        if (v) {
          this.autoTimer = setInterval(() => { this.refresh(); this.refreshQueueCount(); }, 5000);
        } else {
          clearInterval(this.autoTimer);
        }
      });
    },

    async refresh() {
      this.loading = true;
      try {
        if (this.view === "logs") {
          const params = new URLSearchParams({ token: this.token, limit: 100 });
          if (this.statusFilter) params.set("status", this.statusFilter);
          if (this.searchQ) params.set("q", this.searchQ);
          const r = await fetch("/api/logs?" + params.toString());
          const d = await r.json();
          if (d.ok) {
            this.logs = d.logs || [];
            this.stats = d.stats || [];
          }
        } else {
          const params = new URLSearchParams({ token: this.token, limit: 100, status: "pending" });
          const r = await fetch("/api/queue?" + params.toString());
          const d = await r.json();
          if (d.ok) {
            this.queue = d.queue || [];
            this.stats = d.stats || [];
            this.queuePendingCount = (d.stats || []).find(s => s.status === "pending")?.cnt || 0;
          }
        }
      } catch (e) { console.error(e); }
      finally { this.loading = false; }
    },

    async refreshQueueCount() {
      try {
        const r = await fetch("/api/queue?token=" + this.token + "&limit=1&status=pending");
        const d = await r.json();
        if (d.ok) {
          this.queuePendingCount = (d.stats || []).find(s => s.status === "pending")?.cnt || 0;
        }
      } catch(e) {}
    },

    async markConsumed(id) {
      if (!confirm("确认这条已在桌面 Chrome 收录成功了吗？")) return;
      const r = await fetch("/api/queue/consume?token=" + this.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id })
      });
      const d = await r.json();
      if (d.ok) { this.refresh(); this.refreshQueueCount(); }
      else alert("操作失败：" + (d.error || "unknown"));
    },

    async abandonItem(id) {
      if (!confirm("放弃这条？将从待处理队列中移除，不会写入 Notion。")) return;
      const r = await fetch("/api/queue/abandon?token=" + this.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id })
      });
      const d = await r.json();
      if (d.ok) { this.refresh(); this.refreshQueueCount(); }
      else alert("操作失败：" + (d.error || "unknown"));
    },

    copyUrl(url) {
      navigator.clipboard.writeText(url).then(() => {
        // 轻提示，不打断操作
        const original = document.title;
        document.title = "✓ URL 已复制";
        setTimeout(() => { document.title = original; }, 1500);
      });
    },

    toggle(id) {
      this.expanded[id] = !this.expanded[id];
      if (this.expanded[id] && !this.tabs[id]) this.tabs[id] = "coze_in";
    },

    pretty(val) {
      if (!val) return "(空)";
      if (typeof val === "string") {
        try { return JSON.stringify(JSON.parse(val), null, 2); }
        catch (_) { return val; }
      }
      return JSON.stringify(val, null, 2);
    },

    fmtTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      const now = new Date();
      const diff = (now - d) / 1000;
      if (diff < 60) return Math.floor(diff) + "秒前";
      if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
      if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const HH = String(d.getHours()).padStart(2, "0");
      const MM = String(d.getMinutes()).padStart(2, "0");
      return mm + "/" + dd + " " + HH + ":" + MM;
    },

    deviceLabel(d) {
      if (d === "chrome-extension") return "🌐 Chrome";
      if (d === "ios") return "📱 iOS";
      if (d === "cli") return "⌨️ CLI";
      return d || "—";
    },

    statusLabel(s) {
      const m = {
        ok: "✓ 成功",
        recovered: "🔵 救回",
        blocked: "🚫 拦截",
        partial: "⚠ 部分",
        error: "✗ 失败"
      };
      return m[s] || s;
    },

    reasonLabel(r) {
      if (!r) return "?";
      if (r.startsWith("blocked")) return "🚫 拦截";
      if (r === "jina_error") return "⚠ Jina 异常";
      return r;
    },

    copyJson(val) {
      const text = this.pretty(val);
      navigator.clipboard.writeText(text).then(() => alert("已复制到剪贴板 ✓"));
    },
  };
}
</script>
</body>
</html>`;
