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
        <button @click="view='test'; loadPrompts()" :class="view==='test'?'active':''" class="tab-btn">🧪 测试</button>
        <button @click="view='config'; loadConfig()" :class="view==='config'?'active':''" class="tab-btn">⚙️ 配置部署</button>
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
      <button @click="clearLogs()" class="px-3 py-1.5 rounded-md bg-red-600/80 hover:bg-red-500 text-white text-sm font-medium transition">
        🗑 清空日志
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
            <span x-show="log.jina_status" class="text-xs text-gray-500 shrink-0 hidden md:block" x-text="'正文: ' + (log.jina_text_length || 0) + '字'"></span>
            <span class="text-xs text-gray-500 shrink-0" x-text="fmtTime(log.created_at)"></span>
            <span class="text-gray-500 text-xs" x-text="expanded[log.id] ? '▼' : '▶'"></span>
          </div>

          <div x-show="expanded[log.id]" x-transition class="border-t border-gray-800 p-4 space-y-4">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div><span class="text-gray-500">Request ID</span><br><span class="font-mono" x-text="log.request_id"></span></div>
              <div><span class="text-gray-500">耗时</span><br><span x-text="log.duration_ms + ' ms'"></span></div>
              <div><span class="text-gray-500">抓取</span><br><span x-text="log.jina_status || '未触发'"></span></div>
              <div><span class="text-gray-500">Notion</span><br>
                <a x-show="log.notion_page_url" :href="log.notion_page_url" target="_blank" class="text-indigo-400 hover:underline" x-text="log.notion_status || '—'"></a>
                <span x-show="!log.notion_page_url" x-text="log.notion_status || '—'"></span>
              </div>
            </div>

            <div x-show="log.status === 'blocked'" class="p-3 rounded bg-red-950 border border-red-900 text-red-300 text-xs">
              🚫 <b>命中登录墙/验证页</b>：抓取到的是拦截页而非正文。
            </div>
            <div x-show="log.status === 'recovered'" class="p-3 rounded bg-cyan-950 border border-cyan-900 text-cyan-300 text-xs">
              🔵 <b>Wayback Machine 救回</b>：原页面被拦截，从 archive.org 历史快照拿到了正文。
            </div>
            <div x-show="log.error" class="p-3 rounded bg-red-950 border border-red-900 text-red-300 text-xs">
              <b>❌ 错误：</b><span x-text="log.error"></span>
            </div>
            <div x-show="log.coze_error" class="p-3 rounded bg-orange-950 border border-orange-900 text-orange-300 text-xs">
              <b>⚠️ AI分析错误：</b><span x-text="log.coze_error"></span>
            </div>
            <div x-show="log.notion_error" class="p-3 rounded bg-yellow-950 border border-yellow-900 text-yellow-300 text-xs">
              <b>⚠️ Notion错误：</b><span x-text="log.notion_error"></span>
            </div>

            <div>
              <div class="flex gap-1 mb-2 border-b border-gray-800 flex-wrap">
                <button @click="tabs[log.id]='raw'" :class="tabs[log.id]==='raw'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">收到 payload</button>
                <button @click="tabs[log.id]='coze_in'" :class="tabs[log.id]==='coze_in'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">送 AI 的字段 ⭐</button>
                <button @click="tabs[log.id]='coze_out'" :class="tabs[log.id]==='coze_out'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">AI 返回</button>
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
              <button @click="copyJson(log.coze_input)" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">复制 AI 输入</button>
              <a x-show="log.source_url" :href="log.source_url" target="_blank" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">🔗 打开原文</a>
              <a x-show="log.notion_page_url" :href="log.notion_page_url" target="_blank" class="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-indigo-400">→ 打开 Notion</a>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- 主内容：测试 View -->
  <div x-show="view==='test'" class="max-w-4xl mx-auto px-6 py-6 space-y-6">

    <!-- Part 1: 内容提取测试 -->
    <div class="card rounded-lg p-6 space-y-6">
      <div>
        <h2 class="text-lg font-semibold mb-2">🔍 内容提取测试</h2>
        <p class="text-sm text-gray-500">粘贴链接，选择抓取方式，测试 TikHub / Firecrawl 能否成功提取正文。</p>
      </div>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">链接 URL</label>
          <textarea
            x-model="testUrl"
            placeholder="https://www.zhihu.com/pin/2061030932392546866"
            class="w-full h-20 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 focus:border-indigo-500 focus:outline-none text-sm placeholder-gray-500"
          ></textarea>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">抓取方式</label>
          <select
            x-model="testFetcher"
            class="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value="auto">自动（按代码优先级）</option>
            <option value="tikhub">强制 TikHub</option>
            <option value="tikhub_ocr">强制 TikHub + OCR（小红书）</option>
            <option value="firecrawl">强制 Firecrawl</option>
          </select>
          <p class="text-xs text-gray-500 mt-1">
            • 自动：按代码默认优先级（TikHub -> Firecrawl）<br>
            • 强制：跳过优先级，直接使用选中的方式<br>
            • TikHub + OCR：TikHub 提取后强制对图片做火山 OCR（小红书专用）
          </p>
        </div>

        <div class="flex gap-3">
          <button
            @click="runTest()"
            :disabled="testLoading"
            class="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white text-sm font-medium transition"
          >
            <span x-show="!testLoading">▶️ 开始测试</span>
            <span x-show="testLoading">⏳ 测试中…</span>
          </button>
          <button
            @click="clearTest()"
            :disabled="testLoading"
            class="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-gray-200 text-sm font-medium transition"
          >
            清空结果
          </button>
        </div>
      </div>

      <template x-if="testError">
        <div class="border-t border-gray-800 pt-4">
          <div class="p-3 rounded bg-red-950 border border-red-900 text-red-300 text-xs">
            <b>❌ 测试失败：</b><span x-text="testError"></span>
          </div>
        </div>
      </template>

      <template x-if="testResult">
        <div class="border-t border-gray-800 pt-6 space-y-4">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div><span class="text-gray-500">耗时</span><br><span x-text="(testResult.duration_ms || 0) + ' ms'" class="font-mono"></span></div>
            <div><span class="text-gray-500">抓取器</span><br><span x-text="testResult._fetcher || '—'" class="font-mono"></span></div>
            <div><span class="text-gray-500">正文长度</span><br><span x-text="(testResult.text || '').length + ' 字符'" class="font-mono"></span></div>
            <div><span class="text-gray-500">状态</span><br><span x-text="testResult._jina_status || '—'" class="font-mono"></span></div>
          </div>

          <div>
            <div class="flex gap-1 mb-2 border-b border-gray-800 flex-wrap items-center">
              <button @click="testTab='md'" :class="testTab==='md'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">Markdown 预览</button>
              <button @click="testTab='raw'" :class="testTab==='raw'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">原始结果</button>
              <button @click="testTab='item'" :class="testTab==='item'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">解析后字段</button>
              <div class="flex-1"></div>
              <div x-show="testTab==='md' && testResult.text" class="flex gap-2 mb-1">
                <button @click="copyMarkdown()" class="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs">📋 复制 Markdown</button>
                <button @click="downloadMarkdown()" class="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs">⬇️ 下载 .md</button>
              </div>
            </div>
            <div x-show="testTab==='md'" class="code-block whitespace-pre-wrap" x-text="testResult.text || '(无内容)'"></div>
            <div x-show="testTab==='raw'" class="code-block" x-text="pretty(testResult)"></div>
            <div x-show="testTab==='item'" class="code-block" x-text="pretty({ title: testResult.title, author: testResult.author, published_at: testResult.published_at, source_url: testResult.source_url, text_length: (testResult.text || '').length, summary: testResult.summary, key_points: testResult.key_points, _fetcher: testResult._fetcher, _jina_status: testResult._jina_status, _quality: testResult._quality })"></div>
          </div>
        </div>
      </template>
    </div>

    <!-- Part 2: AI 分析测试 -->
    <div class="card rounded-lg p-6 space-y-6">
      <div>
        <h2 class="text-lg font-semibold mb-2">🤖 AI 分析测试</h2>
        <p class="text-sm text-gray-500">填入测试内容，用当前保存的提示词调 AI 模型，查看摘要/分类/标签的生成效果。</p>
      </div>

      <!-- 提示词跳转（配置在「配置部署」里改） -->
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-300">🎨 提示词</h3>
        <a href="#" @click.prevent="view='config'; loadConfig()" class="text-xs text-blue-400 hover:underline">去配置页修改 -></a>
      </div>

      <!-- 测试输入 -->
      <div class="border-t border-gray-800 pt-4 space-y-3">
        <h3 class="text-sm font-medium text-gray-300">🧪 测试输入</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">标题</label>
            <input x-model="promptTest.title" placeholder="测试标题" class="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-sm focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">来源平台</label>
            <input x-model="promptTest.source_platform" placeholder="如：知乎" class="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-sm focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">操作</label>
            <button @click="testPrompt()" :disabled="promptTesting" class="w-full px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white text-sm font-medium transition">
              <span x-show="!promptTesting">▶️ 测试</span>
              <span x-show="promptTesting">⏳ 调用中…</span>
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">测试正文</label>
          <textarea x-model="promptTest.text" placeholder="粘贴测试用的正文内容…" class="w-full h-32 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-sm focus:outline-none focus:border-indigo-500 resize-y"></textarea>
        </div>
      </div>

      <!-- 测试结果 -->
      <template x-if="promptTestResult">
        <div class="border-t border-gray-800 pt-4 space-y-3">
          <div class="flex gap-1 border-b border-gray-800">
            <button @click="promptTestTab='parsed'" :class="promptTestTab==='parsed'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">AI 返回（解析后）</button>
            <button @click="promptTestTab='raw'" :class="promptTestTab==='raw'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">原始返回</button>
            <button @click="promptTestTab='usage'" :class="promptTestTab==='usage'?'text-indigo-400 border-indigo-400':'text-gray-500 border-transparent'" class="px-3 py-1.5 text-xs border-b-2 transition">耗时 & Token</button>
          </div>
          <div x-show="promptTestTab==='parsed'" class="code-block" x-text="pretty(promptTestResult.parsed)"></div>
          <div x-show="promptTestTab==='raw'" class="code-block" x-text="promptTestResult.raw_content || '(空)'"></div>
          <div x-show="promptTestTab==='usage'" class="grid grid-cols-3 gap-3 text-xs">
            <div><span class="text-gray-500">耗时</span><br><b x-text="promptTestResult.duration_ms + ' ms'"></b></div>
            <div><span class="text-gray-500">模型</span><br><b x-text="promptTestResult.model || '-'"></b></div>
            <div><span class="text-gray-500">Token</span><br><b x-text="JSON.stringify(promptTestResult.usage || {})"></b></div>
          </div>
        </div>
      </template>

      <div x-show="promptTestError" class="p-3 rounded-md bg-red-950 border border-red-900 text-red-300 text-sm">
        ❌ <span x-text="promptTestError"></span>
      </div>
    </div>
  </div>

  <!-- 主内容：配置部署 View -->
  <div x-show="view==='config'" class="max-w-4xl mx-auto px-6 py-6">

    <!-- 整体流程示意图 -->
    <div class="mb-6">
      <h2 class="text-lg font-semibold mb-1">📋 整体流程示意图</h2>
      <p class="text-sm text-gray-500 mb-3">用户发送一条链接后，系统内部的完整处理过程。</p>
    </div>
    <div class="mb-6 rounded-xl p-4" style="background: #12121f; border: 1px solid #2a2a4a;">

      <div class="flex items-stretch gap-2">

        <!-- 左侧：用户发送（分叉） -->
        <div class="flex flex-col gap-2 justify-center min-w-[120px]">
          <div class="flex items-center gap-2 rounded-lg p-1.5" style="background:#1a1a2e;border:1px solid #2a2a4a;">
            <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style="background:#1e2a3a;border:1px solid #2d4a6a;">💻</div>
            <div class="text-[10px] leading-tight">
              <div class="text-gray-300 font-medium">电脑端发送</div>
              <div class="text-gray-600">Chrome 插件</div>
            </div>
          </div>
          <div class="flex items-center gap-2 rounded-lg p-1.5" style="background:#1a1a2e;border:1px solid #2a2a4a;">
            <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style="background:#1e2a3a;border:1px solid #2d4a6a;">📱</div>
            <div class="text-[10px] leading-tight">
              <div class="text-gray-300 font-medium">手机端发送</div>
              <div class="text-gray-600">iOS 快捷指令</div>
            </div>
          </div>
        </div>

        <!-- 箭头：url -->
        <div class="flex flex-col items-center justify-center min-w-[50px]">
          <div class="text-[10px] text-indigo-400 font-mono mb-0.5">url</div>
          <div class="text-gray-600 text-lg">→</div>
        </div>

        <!-- 中间：Worker 大框 -->
        <div class="flex-1 rounded-lg p-3" style="background: #0d0d18; border: 1px solid #2a2a4a;">
          <div class="text-[10px] text-gray-500 mb-2 text-center">☁️ Cloudflare Worker</div>
          <div class="flex items-center justify-between gap-1">
            <!-- 内容提取 -->
            <div class="flex flex-col items-center min-w-0 flex-1">
              <div class="w-9 h-9 rounded-full flex items-center justify-center text-sm" style="background:#2a2a1e;border:1px solid #5a5a2d;">🔍</div>
              <div class="text-xs text-gray-300 mt-1 text-center font-medium leading-tight">内容提取</div>
              <div class="text-[10px] text-gray-600 mt-0.5 text-center leading-tight">优先TikHub<br>其次Firecrawl<br>小红书补充OCR</div>
            </div>
            <!-- 箭头：title + content -->
            <div class="flex flex-col items-center justify-center min-w-[50px]">
              <div class="text-[10px] text-indigo-400 font-mono leading-tight text-center">title<br>content</div>
              <div class="text-gray-600 text-sm">→</div>
            </div>
            <!-- AI 分析 -->
            <div class="flex flex-col items-center min-w-0 flex-1">
              <div class="w-9 h-9 rounded-full flex items-center justify-center text-sm" style="background:#2a1e3a;border:1px solid #4a3a6a;">🤖</div>
              <div class="text-xs text-gray-300 mt-1 text-center font-medium leading-tight">AI 分析</div>
              <div class="text-[10px] text-gray-600 mt-0.5 text-center leading-tight">摘要+分类<br>+标签</div>
            </div>
          </div>
        </div>

        <!-- 箭头：summary + category + tags -->
        <div class="flex flex-col items-center justify-center min-w-[50px]">
          <div class="text-[10px] text-indigo-400 font-mono leading-tight text-center">summary<br>category<br>tags</div>
          <div class="text-gray-600 text-lg">→</div>
        </div>

        <!-- 写入 Notion -->
        <div class="flex flex-col items-center justify-center min-w-[80px]">
          <div class="w-10 h-10 rounded-full flex items-center justify-center text-base" style="background:#1e2a2a;border:1px solid #2d5a5a;">📝</div>
          <div class="text-xs text-gray-300 mt-1.5 text-center font-medium">写入知识库</div>
          <div class="text-[10px] text-gray-600 mt-0.5 text-center leading-tight">Notion<br>数据库</div>
        </div>

        <!-- 箭头：异步通知 -->
        <div class="flex flex-col items-center justify-center min-w-[50px]">
          <div class="text-[10px] text-indigo-400 font-mono mb-0.5">异步通知</div>
          <div class="text-gray-600 text-lg">→</div>
        </div>

        <!-- 右侧：通知分叉 -->
        <div class="flex flex-col gap-2 justify-center min-w-[120px]">
          <!-- 电脑端通知 -->
          <div class="flex items-center gap-2 rounded-lg p-1.5" style="background:#1a1a2e;border:1px solid #2a2a4a;">
            <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style="background:#1e2a3a;border:1px solid #2d4a6a;">💻</div>
            <div class="text-[10px] leading-tight">
              <div class="text-gray-300 font-medium">电脑端通知</div>
              <div class="text-gray-600">Chrome插件弹窗</div>
            </div>
          </div>
          <!-- 手机端通知 -->
          <div class="flex items-center gap-2 rounded-lg p-1.5" style="background:#1a1a2e;border:1px solid #2a2a4a;">
            <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style="background:#2a2a1e;border:1px solid #5a5a2d;">🔔</div>
            <div class="text-[10px] leading-tight">
              <div class="text-gray-300 font-medium">手机端通知</div>
              <div class="text-gray-600">手机端Bark推送</div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <div class="mb-6">
      <h2 class="text-lg font-semibold mb-1">⚙️ 配置部署</h2>
      <p class="text-sm text-gray-500">按步骤完成各部分配置，每步配置好后点保存即可生效。</p>
    </div>

    <!-- Step 1: 内容提取 -->
    <div id="step-1" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style="background:#2a2a1e;border:1px solid #5a5a2d;color:#aaa66a;">1</span>
        <h3 class="text-sm font-semibold text-gray-200">配置内容提取</h3>
        <span class="text-xs text-gray-600">TikHub 优先 → Firecrawl 兜底 → 小红书额外 OCR</span>
      </div>
      <div class="card rounded-lg p-4 space-y-3 mb-4">
        <p class="text-xs text-gray-400">收录一条链接时，系统需要把网页正文抓取下来，这一步配置 3 个内容提取服务。点击下方卡片填入 API Key 即可。</p>
        <div class="text-xs text-gray-500 space-y-1.5">
          <p>🔹 <b class="text-gray-300">TikHub</b>：知乎、小红书、B站、微信公众号等平台的正文提取，<b class="text-gray-300">必须配置</b>。在 tikhub.io 注册账号即可获取 Key。</p>
          <p>🔹 <b class="text-gray-300">Firecrawl</b>：通用网页正文提取，支持的页面不全、效果一般，仅做兜底。在 firecrawl.dev 注册获取。</p>
          <p>🔹 <b class="text-gray-300">火山引擎 OCR</b>：小红书图片文字识别，想抓小红书图文信息才需要配。⚠️ <b class="text-yellow-400/80">配 AK/SK 前，先在火山引擎控制台开通免费的「通用文字识别 OCR」服务（免费 5000 次），路径：控制台搜索框搜「OCR」或「视觉智能 → 文字识别 → 通用文字识别」</b>。开通后再去「访问控制 → API访问密钥」创建 AK/SK。</p>
        </div>
        <div class="rounded-md p-2.5" style="background: rgba(106,154,218,0.1); border: 1px solid rgba(106,154,218,0.3);">
          <p class="text-xs text-indigo-300">💡 三个都配效果最好。至少要配置 TikHub（Firecrawl 支持的抓取页面不全、效果不好，仅做兜底），否则无法抓取网页正文。另外如果期望抓取小红书上的图文信息，就必须配置 OCR 能力。</p>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <template x-for="(ch, ci) in configChannels.filter(c => c.section === 'extract')" :key="ch.id">
          <div @click="openConfigModal(configChannels.indexOf(ch))" class="cursor-pointer rounded-xl p-4 border transition group hover:border-indigo-500" :class="ch.allConfigured ? 'bg-gray-900/50 border-gray-800' : 'bg-gray-900/30 border-gray-800 hover:border-indigo-500'">
            <div class="flex items-start justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xl" x-text="ch.icon"></span>
                <div>
                  <div class="text-sm font-semibold text-gray-100" x-text="ch.title"></div>
                  <div class="text-xs text-gray-500" x-text="ch.purpose"></div>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap" :class="ch.allConfigured ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'" x-text="ch.allConfigured ? '已配置' : '未配置'"></span>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <template x-for="key in ch.keys" :key="key.name">
                <span class="text-xs px-1.5 py-0.5 rounded" :class="key.configured ? 'bg-green-900/30 text-green-400/80' : 'bg-gray-800 text-gray-500'" x-text="key.short"></span>
              </template>
            </div>
            <div class="mt-3 flex justify-end" @click.stop>
              <button @click="testChannel(configChannels.indexOf(ch))" :disabled="ch.testing" class="text-xs px-2.5 py-1 rounded-md transition" :class="ch.testing ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'">
                <span x-show="!ch.testing">🔌 测试连通</span>
                <span x-show="ch.testing">⏳ 测试中…</span>
              </button>
            </div>
            <div x-show="ch.testMsg" x-transition class="mt-2 text-xs" :class="ch.testOk ? 'text-green-400' : 'text-red-400'" x-text="ch.testMsg"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Step 2: AI 分析 -->
    <div id="step-2" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style="background:#2a1e3a;border:1px solid #4a3a6a;color:#a87ada;">2</span>
        <h3 class="text-sm font-semibold text-gray-200">配置 AI 分析</h3>
        <span class="text-xs text-gray-600">摘要 / 分类 / 标签，含提示词配置</span>
      </div>
      <div class="card rounded-lg p-4 space-y-3 mb-4">
        <p class="text-xs text-gray-400">配置一个大模型，收录内容后自动生成摘要、分类和标签，方便日后检索。</p>
        <div class="text-xs text-gray-500 space-y-1.5">
          <p>🔹 支持所有 OpenAI 兼容接口的大模型：DeepSeek、OpenAI、通义千问、豆包、智谱等都可以。</p>
          <p>🔹 点击下方卡片，在弹窗里填入三项：API Key、Base URL、模型名。Base URL 填你的大模型接口地址（填域名即可，自动补 /chat/completions）。</p>
          <p>🔹 提示词是可选的，系统有默认值。你也可以在弹窗里自定义提示词。</p>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <template x-for="(ch, ci) in configChannels.filter(c => c.section === 'ai')" :key="ch.id">
          <div @click="openConfigModal(configChannels.indexOf(ch))" class="cursor-pointer rounded-xl p-4 border transition group hover:border-indigo-500" :class="ch.allConfigured ? 'bg-gray-900/50 border-gray-800' : 'bg-gray-900/30 border-gray-800 hover:border-indigo-500'">
            <div class="flex items-start justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xl" x-text="ch.icon"></span>
                <div>
                  <div class="text-sm font-semibold text-gray-100" x-text="ch.title"></div>
                  <div class="text-xs text-gray-500" x-text="ch.purpose"></div>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap" :class="ch.allConfigured ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'" x-text="ch.allConfigured ? '已配置' : '未配置'"></span>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <template x-for="key in ch.keys" :key="key.name">
                <span class="text-xs px-1.5 py-0.5 rounded" :class="key.configured ? 'bg-green-900/30 text-green-400/80' : 'bg-gray-800 text-gray-500'" x-text="key.short"></span>
              </template>
            </div>
            <div class="mt-3 flex justify-end" @click.stop>
              <button @click="testChannel(configChannels.indexOf(ch))" :disabled="ch.testing" class="text-xs px-2.5 py-1 rounded-md transition" :class="ch.testing ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'">
                <span x-show="!ch.testing">🔌 测试连通</span>
                <span x-show="ch.testing">⏳ 测试中…</span>
              </button>
            </div>
            <div x-show="ch.testMsg" x-transition class="mt-2 text-xs" :class="ch.testOk ? 'text-green-400' : 'text-red-400'" x-text="ch.testMsg"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Step 3: 写入知识库 -->
    <div id="step-3" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style="background:#1e2a2a;border:1px solid #2d5a5a;color:#6aaaaa;">3</span>
        <h3 class="text-sm font-semibold text-gray-200">配置知识库写入</h3>
        <span class="text-xs text-gray-600">收录的内容写入 Notion 数据库</span>
      </div>
      <div class="card rounded-lg p-4 space-y-3 mb-4">
        <p class="text-xs text-gray-400">收录的内容最终会写入 Notion 数据库。需要先在 Notion 里做好准备，拿到 Token 和数据库 ID，再填到下方卡片里。</p>
        <div class="text-xs text-gray-500 space-y-1.5">
          <p>① 打开 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">notion.so/profile/integrations</code>，创建一个内部集成，获取 Token。</p>
          <p>② 在 Notion 新建一个数据库（表格视图），需要添加以下属性（列）：</p>
          <div class="ml-3 space-y-0.5 text-gray-400">
            <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Title</code>（标题）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Summary</code>（文本）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Category</code>（单选）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Tags</code>（多选）</p>
            <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Source URL</code>（URL）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Source Platform</code>（单选）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Content Type</code>（单选）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Key Points</code>（文本）</p>
            <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Author</code>（文本）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Entities</code>（文本）</p>
            <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Captured At</code>（日期）、<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Published At</code>（日期）</p>
          </div>
          <p class="text-gray-500">列名必须保持英文，Notion 不区分大小写但名字要对上。</p>
          <div class="rounded-md p-3 my-2" style="background: rgba(106,154,218,0.08); border: 1px solid rgba(106,154,218,0.3);">
            <p class="text-xs text-indigo-300 font-medium mb-2">📋 字段来源说明（12 个字段）</p>
            <p class="text-xs text-gray-400 mb-1.5">以下 6 个由系统自动填充，<b class="text-gray-300">提示词改不了</b>：</p>
            <div class="text-xs text-gray-500 ml-3 space-y-0.5 mb-2">
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Source URL</code> — 你收录的链接</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Captured At</code> — 收录时间（自动取当前）</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Source Platform</code> — 按链接域名识别（知乎/小红书/B站等）</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Content Type</code> — 按平台和内容推断（文章/视频字幕/图文）</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Author</code> — 从页面 meta 标签 / TikHub API 提取</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Published At</code> — 从源文章发布时间提取（抓不到则为空）</p>
            </div>
            <p class="text-xs text-gray-400 mb-1.5">以下 6 个由 AI 生成，<b class="text-gray-300">可通过提示词调整</b>：</p>
            <div class="text-xs text-gray-500 ml-3 space-y-0.5">
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Title</code>、<code class="bg-gray-800 px-1 rounded text-indigo-400">Summary</code>、<code class="bg-gray-800 px-1 rounded text-indigo-400">Key Points</code> — 标题 / 摘要 / 要点</p>
              <p>• <code class="bg-gray-800 px-1 rounded text-indigo-400">Category</code>、<code class="bg-gray-800 px-1 rounded text-indigo-400">Tags</code>、<code class="bg-gray-800 px-1 rounded text-indigo-400">Entities</code> — 分类 / 标签 / 实体</p>
              <p class="text-xs mt-1.5 px-2 py-1.5 rounded" style="background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.4); color: #fbbf24;">⚠️ 这 6 个字段名是<b>固定的，不能增减</b>。内容要求（摘要字数、要点条数、分类选项、标签池等）可在提示词里自由调整。如果增删字段或 Notion 上字段不匹配，系统都会<b>报错</b>。</p>
            </div>
          </div>
          <div class="rounded-md p-2.5 my-2" style="background: rgba(106,154,218,0.12); border: 1px solid rgba(106,154,218,0.4);">
            <p class="text-xs text-indigo-300"><b>💡 可调整的内容：</b>摘要字数范围、要点条数、分类列表选项、标签池内容、实体识别范围——这些都在用户提示词里对应的字段行修改，不影响字段数量。</p>
          </div>
          <p>③ 把数据库分享给刚才创建的集成：点数据库页面右上角 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">···</code> -> <b>集成</b> -> 在搜索框输入你创建的集成名称 -> 点弹窗里的「添加到页面」。</p>
          <p>④ 获取数据库 ID：先在左侧侧边栏点击你的数据库，打开数据库页面后，看浏览器地址栏 URL，<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">/p/</code> 后面到 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">?</code> 之前那串 32 位字符就是。例如 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">app.notion.com/p/3c095c5c...a?v=...</code>，取 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">?</code> 前面的那串。</p>
        </div>
        <div class="rounded-md p-2.5" style="background: rgba(250,204,21,0.1); border: 1px solid rgba(250,204,21,0.3);">
          <p class="text-xs text-yellow-400">⚠️ 第③步一定要做，否则集成没有权限写入数据库。</p>
        </div>
        <p class="text-xs text-gray-400 pt-1">准备好后，点击下方卡片填入 Notion Token 和数据库 ID。</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <template x-for="(ch, ci) in configChannels.filter(c => c.section === 'store')" :key="ch.id">
          <div @click="openConfigModal(configChannels.indexOf(ch))" class="cursor-pointer rounded-xl p-4 border transition group hover:border-indigo-500" :class="ch.allConfigured ? 'bg-gray-900/50 border-gray-800' : 'bg-gray-900/30 border-gray-800 hover:border-indigo-500'">
            <div class="flex items-start justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xl" x-text="ch.icon"></span>
                <div>
                  <div class="text-sm font-semibold text-gray-100" x-text="ch.title"></div>
                  <div class="text-xs text-gray-500" x-text="ch.purpose"></div>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap" :class="ch.allConfigured ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'" x-text="ch.allConfigured ? '已配置' : '未配置'"></span>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <template x-for="key in ch.keys" :key="key.name">
                <span class="text-xs px-1.5 py-0.5 rounded" :class="key.configured ? 'bg-green-900/30 text-green-400/80' : 'bg-gray-800 text-gray-500'" x-text="key.short"></span>
              </template>
            </div>
            <div class="mt-3 flex justify-end" @click.stop>
              <button @click="testChannel(configChannels.indexOf(ch))" :disabled="ch.testing" class="text-xs px-2.5 py-1 rounded-md transition" :class="ch.testing ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'">
                <span x-show="!ch.testing">🔌 测试连通</span>
                <span x-show="ch.testing">⏳ 测试中…</span>
              </button>
            </div>
            <div x-show="ch.testMsg" x-transition class="mt-2 text-xs" :class="ch.testOk ? 'text-green-400' : 'text-red-400'" x-text="ch.testMsg"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Step 4: 安装客户端 -->
    <div id="step-5" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style="background:#1e2a3a;border:1px solid #2d4a6a;color:#6a9ada;">4</span>
        <h3 class="text-sm font-semibold text-gray-200">安装客户端</h3>
        <span class="text-xs text-gray-600">配置好后，在手机和电脑上安装收录入口</span>
      </div>
      <div class="card rounded-lg p-4 space-y-4">
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-2">📱 iOS 快捷指令</h3>
          <p class="text-xs text-gray-500 mb-2">在 iPhone 上用快捷指令 App 创建一个「一键收录」的快捷指令，以后在任何 App 里复制链接就能直接收录。</p>
          <div class="text-xs text-gray-500 space-y-1.5">
            <p>① 打开「快捷指令」App，新建一个快捷指令。</p>
            <p>② 添加操作「获取剪贴板」。</p>
            <p>③ 添加操作「URL」，填入你的收录地址：<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">https://&lt;你的Worker域名&gt;/ingest</code></p>
            <p>④ 添加操作「获取 URL 内容」，把方法改为 POST。</p>
            <p>⑤ 展开请求头，添加两个请求头：</p>
            <div class="ml-3 space-y-0.5 text-gray-400">
              <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Content-Type: application/json</code></p>
              <p>• <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">Authorization: Bearer <你的 INGEST_TOKEN&gt;</code> <span class="text-gray-600">（注意：Bearer 和 <你的 INGEST_TOKEN> 之间有一个空格）</span></p>
              <p class="text-gray-600">👉 <b class="text-gray-400">INGEST_TOKEN 就是部署时打印的令牌</b>，部署成功后打印「INGEST_TOKEN: xxx」。</p>
            </div>
            <p>⑥ 请求体改为 JSON，填入：<code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">{"url":"[[剪贴板]]"}</code> <span class="text-gray-600">（请求体选 JSON 后，下面会显示「键」和「文本」两个输入框：<b>键</b> 直接打字填 <code class="bg-gray-800 px-1 rounded text-indigo-400">url</code>（固定字段名，不需要选变量）；<b>文本</b> 不要手动打字，点输入框下方的「选择变量」，在变量列表里选「剪贴板」，会变成蓝色的「剪贴板」磁贴。最终效果等于 {"url":"[[剪贴板]]"}）</span></p>
            <p>⑦ 点编辑页面中间正下方（操作列表底部）的 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">i</code> 图标，开启「在共享表单中显示」开关，然后返回保存。</p><p>⑧ 保存后，在任何 App 里复制链接，点分享按钮，点<b>更多</b>，往下滑找到「一键收录」快捷指令即可收录（可以将快捷方式收藏，让位置靠前）。<b>小红书因平台限制，需先复制链接到微信或浏览器后才能分享。</b></p><div class="rounded-md p-2.5 my-2" style="background: rgba(250,204,21,0.1); border: 1px solid rgba(250,204,21,0.3);"><p class="text-xs text-yellow-400">⚠️ <b>手机端收录超时怎么办？</b> 如果快捷指令运行很久后提示「请求超时」，通常是网络问题——<code class="bg-gray-800 px-1 rounded text-yellow-200">workers.dev</code> 域名在国内部分网络下会被墙或不稳定。解决办法：① 开启代理/VPN 后重试；② 或给 Worker 绑定自己的自定义域名（如 <code class="bg-gray-800 px-1 rounded text-yellow-200">kb.你的域名.com</code>），把快捷指令 URL 里的域名替换掉。电脑端 Chrome 插件遇到同样问题也是这个原因。</p></div>
          </div>
        </div>
        <div class="border-t border-gray-800 pt-3">
          <h3 class="text-sm font-medium text-gray-300 mb-2">🌐 Chrome 插件</h3>
          <p class="text-xs text-gray-500 mb-2">插件代码在项目的 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">chrome-extension/</code> 目录。</p>
          <div class="text-xs text-gray-500 space-y-1.5">
            <p>① 用<b>谷歌浏览器</b>打开 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">chrome://extensions/</code>，开启右上角「开发者模式」。</p>
            <p>② 点「加载已解压的扩展程序」，选中项目里的 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">chrome-extension/</code> 目录。</p>
            <p>③ 点击插件图标 -> 设置 -> 填入 Worker URL 和 INGEST_TOKEN，保存。</p>
          </div>
          <div class="mt-2 rounded-md p-2.5" style="background: #2a2a1e; border: 1px solid #5a5a2d;">
            <p class="text-xs text-yellow-400/80">🔔 <b>开启通知权限</b>：收录完成后插件会弹系统通知提醒你，需在 macOS 设置 -> 通知 -> Google Chrome 中允许通知，否则只弹窗内提示。</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 5: 推送通知 -->
    <div id="step-4" class="mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style="background:#2a2a1e;border:1px solid #5a5a2d;color:#aaa66a;">5</span>
        <h3 class="text-sm font-semibold text-gray-200">配置推送通知</h3>
        <span class="text-xs text-gray-600">收录完成后推送到手机</span>
      </div>
      <div class="card rounded-lg p-4 space-y-3 mb-4">
        <p class="text-xs text-gray-400">收录完成后可以给你的手机发推送通知。仅手机端需要配置，电脑端 Chrome 插件自带通知不需要配。</p>
        <div class="text-xs text-gray-500 space-y-1.5">
          <p>🔹 <b class="text-gray-300">Bark</b> 是一个免费的 iOS 推送 App，收录完成后手机会收到通知。</p>
          <p>① 在 App Store 搜索并安装 Bark。</p>
          <p>② 打开 Bark，首页顶部会显示一条 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">https://api.day.app/xxxxxxxx</code> 的链接，<b class="text-gray-300">最后那串 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">/</code> 后面的字符就是你的 Key</b>（如 <code class="bg-gray-800 px-1.5 py-0.5 rounded text-indigo-400">xxxxxxxx</code> 样式的随机字符），复制它填到下方卡片。页面其他内容（推送标题/铃声/测试URL）都不用管。</p>
        </div>
        <p class="text-xs text-gray-400 pt-1">点击下方卡片填入 Bark Key 即可。</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <template x-for="(ch, ci) in configChannels.filter(c => c.section === 'notify')" :key="ch.id">
          <div @click="openConfigModal(configChannels.indexOf(ch))" class="cursor-pointer rounded-xl p-4 border transition group hover:border-indigo-500" :class="ch.allConfigured ? 'bg-gray-900/50 border-gray-800' : 'bg-gray-900/30 border-gray-800 hover:border-indigo-500'">
            <div class="flex items-start justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xl" x-text="ch.icon"></span>
                <div>
                  <div class="text-sm font-semibold text-gray-100" x-text="ch.title"></div>
                  <div class="text-xs text-gray-500" x-text="ch.purpose"></div>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap" :class="ch.allConfigured ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'" x-text="ch.allConfigured ? '已配置' : '未配置'"></span>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <template x-for="key in ch.keys" :key="key.name">
                <span class="text-xs px-1.5 py-0.5 rounded" :class="key.configured ? 'bg-green-900/30 text-green-400/80' : 'bg-gray-800 text-gray-500'" x-text="key.short"></span>
              </template>
            </div>
            <div class="mt-3 flex justify-end" @click.stop>
              <button @click="testChannel(configChannels.indexOf(ch))" :disabled="ch.testing" class="text-xs px-2.5 py-1 rounded-md transition" :class="ch.testing ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'">
                <span x-show="!ch.testing">🔌 测试连通</span>
                <span x-show="ch.testing">⏳ 测试中…</span>
              </button>
            </div>
            <div x-show="ch.testMsg" x-transition class="mt-2 text-xs" :class="ch.testOk ? 'text-green-400' : 'text-red-400'" x-text="ch.testMsg"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <div
      x-show="configModal.open"
      x-transition.opacity
      class="fixed inset-0 z-50 flex items-center justify-center"
      style="background: rgba(0,0,0,0.6);"
      @click.self="closeConfigModal()"
      x-cloak
    >
      <div class="rounded-xl p-6 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto" style="background: #1a1a2e; border: 1px solid #2a2a4a;">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <span class="text-xl" x-text="configModal.icon"></span>
            <h3 class="text-base font-semibold text-gray-100" x-text="configModal.title"></h3>
          </div>
          <button @click="closeConfigModal()" class="text-gray-500 hover:text-gray-300 text-lg">✕</button>
        </div>
        <p class="text-xs text-gray-500 mb-4" x-text="configModal.purpose"></p>

        <!-- 密钥字段 -->
        <div class="space-y-4">
          <template x-for="(field, fi) in configModal.fields" :key="field.name">
            <div>
              <div class="flex items-center gap-1.5 mb-1">
                <span class="text-xs" :class="field.configured ? 'text-green-400' : 'text-red-400'" x-text="field.configured ? '✅' : '❌'"></span>
                <label class="text-sm font-medium text-gray-300" x-text="field.title"></label>
                <a x-show="field.url" :href="field.url" target="_blank" class="text-xs text-blue-400 hover:underline ml-auto">获取 →</a>
              </div>
              <p class="text-xs text-gray-500 mb-1.5" x-text="field.hint"></p>
              <input
                :type="(field.name === 'NOTION_DATABASE_ID' || field.name === 'LLM_BASE_URL' || field.name === 'LLM_MODEL') ? 'text' : 'password'"
                :placeholder="field.configured ? '已配置，输入新值可覆盖' : (field.name === 'LLM_BASE_URL' ? '粘贴 URL…' : field.name === 'LLM_MODEL' ? '输入模型名…' : '粘贴 Key…')"
                x-model="field.value"
                class="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 focus:border-indigo-500 focus:outline-none text-sm font-mono"
              />
              <div x-show="field.msg" x-transition class="mt-1 text-xs" :class="field.msgOk ? 'text-green-400' : 'text-red-400'" x-text="field.msg"></div>
            </div>
          </template>
        </div>

        <!-- 保存密钥（紧跟字段区，位于弹窗上部） -->
        <div class="flex justify-end mt-4">
          <button @click="saveConfigModal()" :disabled="configModal.saving" class="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium transition">
            <span x-show="!configModal.saving">💾 保存密钥</span>
            <span x-show="configModal.saving">⏳ 保存中…</span>
          </button>
        </div>

        <!-- 鉴权使用说明（仅收录鉴权渠道） -->
        <template x-if="configModal.idx >= 0 && configChannels[configModal.idx]?.section === 'auth'">
          <div class="border-t border-gray-700 mt-5 pt-4 space-y-3">
            <h4 class="text-sm font-medium text-gray-300">📋 填完后还需要在哪里配置？</h4>
            <div class="space-y-2.5 text-xs text-gray-400">
              <div class="flex gap-2">
                <span class="text-gray-600 flex-shrink-0">①</span>
                <div>
                  <span class="text-gray-300 font-medium">手机 iOS 快捷指令</span> -- 编辑快捷指令的 HTTP 请求头，添加：
                  <code class="text-indigo-400 bg-gray-900 px-1 py-0.5 rounded mt-1 inline-block">Authorization: Bearer &lt;你的 INGEST_TOKEN&gt;</code>
                </div>
              </div>
              <div class="flex gap-2">
                <span class="text-gray-600 flex-shrink-0">②</span>
                <div>
                  <span class="text-gray-300 font-medium">电脑浏览器插件</span> -- 打开插件设置页，把 INGEST_TOKEN 粘贴到「API Token」或「鉴权令牌」输入框
                </div>
              </div>
              <div class="flex gap-2">
                <span class="text-gray-600 flex-shrink-0">③</span>
                <div>
                  <span class="text-gray-300 font-medium">监控台登录</span> -- 浏览器打开时 URL 里带上：
                  <code class="text-indigo-400 bg-gray-900 px-1 py-0.5 rounded mt-1 inline-block">?token=&lt;你的 INGEST_TOKEN&gt;</code>
                </div>
              </div>
              <div class="flex gap-2">
                <span class="text-gray-600 flex-shrink-0">④</span>
                <div>
                  <span class="text-gray-300 font-medium">Worker 端</span> -- 就是上面这个输入框，保存后 Worker 用它来比对所有请求
                </div>
              </div>
            </div>
            <div class="p-2.5 rounded-md bg-yellow-950/30 border border-yellow-900/50 text-xs text-yellow-300/80">
              ⚠️ 改了 Token 后，手机快捷指令和浏览器插件那边也要同步更新，否则收录会失败。
            </div>
          </div>
        </template>

        <!-- 提示词区域（仅 AI 智能分析渠道） -->
        <template x-if="configModal.idx >= 0 && configChannels[configModal.idx]?.section === 'ai'">
          <div class="border-t border-gray-700 mt-5 pt-4 space-y-4">
            <div class="flex items-center justify-between">
              <h4 class="text-sm font-medium text-gray-300">🎨 提示词配置</h4>
              <div class="flex gap-2">
                <button @click="resetPrompts()" class="px-2.5 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs transition">↩️ 恢复默认</button>
                <button @click="savePrompts()" :disabled="promptsSaving" class="px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition">
                  <span x-show="!promptsSaving">💾 保存提示词</span>
                  <span x-show="promptsSaving">⏳</span>
                </button>
              </div>
            </div>

            <div x-show="promptsSaved" x-transition class="p-2 rounded-md bg-green-950 border border-green-900 text-green-300 text-xs">
              ✅ 提示词已保存，新的收录请求将使用新提示词。
            </div>

            <!-- System Prompt -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="text-xs font-medium text-gray-400">System Prompt（系统提示词）</label>
                <span class="text-xs text-gray-500" x-text="promptForm.system_prompt.length + ' 字符'"></span>
              </div>
              <textarea
                x-model="promptForm.system_prompt"
                class="w-full h-48 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 focus:border-indigo-500 focus:outline-none text-xs font-mono placeholder-gray-500 resize-y"
                placeholder="输入系统提示词…"
              ></textarea>
            </div>

            <!-- User Template -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="text-xs font-medium text-gray-400">User Template（用户消息模板）</label>
                <span class="text-xs text-gray-500" x-text="promptForm.user_template.length + ' 字符'"></span>
              </div>
              <p class="text-xs text-gray-500 mb-1">占位符：<code class="text-indigo-400">{{title}}</code> <code class="text-indigo-400">{{source_platform}}</code> <code class="text-indigo-400">{{text}}</code></p>
              <textarea
                x-model="promptForm.user_template"
                class="w-full h-36 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 focus:border-indigo-500 focus:outline-none text-xs font-mono placeholder-gray-500 resize-y"
                placeholder="输入用户消息模板…"
              ></textarea>
            </div>

            <p class="text-xs text-gray-500">💡 提示词测试请到「测试」页面进行</p>
          </div>
        </template>

        <!-- 底部按钮（只留关闭，保存已在字段区上方） -->
        <div class="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-700">
          <button @click="closeConfigModal()" class="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm transition">关闭</button>
        </div>
      </div>
    </div>
  </div>

<script>
function app() {
  return {
    view: "logs",
    logs: [],
    stats: [],
    expanded: {},
    tabs: {},
    loading: false,
    autoRefresh: false,
    autoTimer: null,
    statusFilter: "",
    searchQ: "",
    token: new URLSearchParams(location.search).get("token") || "",
    // 测试相关
    testUrl: "",
    testFetcher: "auto",
    testLoading: false,
    testResult: null,
    testError: "",
    testTab: "md",
    // 配置部署
    configKeys: [],
    configChannels: [],
    configModal: { open: false, idx: -1, icon: "", title: "", purpose: "", fields: [], saving: false },
    // 提示词
    promptForm: { system_prompt: "", user_template: "" },
    promptsSaving: false,
    promptsSaved: false,
    promptTest: { title: "", source_platform: "", text: "" },
    promptTesting: false,
    promptTestResult: null,
    promptTestError: "",
    promptTestTab: "parsed",

    init() {
      const hash = location.hash.slice(1);
      if (hash === "config") { this.view = "config"; this.loadConfig(); }
      this.refresh();
      this.$watch("autoRefresh", (v) => {
        if (v) {
          this.autoTimer = setInterval(() => { this.refresh(); }, 5000);
        } else {
          clearInterval(this.autoTimer);
        }
      });
    },

    async refresh() {
      this.loading = true;
      try {
        const params = new URLSearchParams({ token: this.token, limit: 100 });
        if (this.statusFilter) params.set("status", this.statusFilter);
        if (this.searchQ) params.set("q", this.searchQ);
        const r = await fetch("/api/logs?" + params.toString());
        const d = await r.json();
        if (d.ok) {
          this.logs = d.logs || [];
          this.stats = d.stats || [];
        }
      } catch (e) { console.error(e); }
      finally { this.loading = false; }
    },

    async clearLogs() {
      if (!confirm("确定清空所有收录日志吗？此操作不可撤销！")) return;
      if (!confirm("再次确认：清空后无法恢复，Notion 页面不受影响。")) return;
      const r = await fetch("/api/logs/clear?token=" + this.token, { method: "POST" });
      const d = await r.json();
      if (d.ok) { this.refresh(); }
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

    // ========== 测试抓取 ==========
    async runTest() {
      if (!this.testUrl.trim()) {
        alert("请先粘贴链接 URL");
        return;
      }
      this.testLoading = true;
      this.testResult = null;
      this.testError = "";
      try {
        const payload = {
          source_url: this.testUrl.trim(),
          capture_device: "cli",
          force_fetcher: this.testFetcher !== "auto" ? this.testFetcher : undefined,
        };
        const r = await fetch("/api/test-fetch?token=" + this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (!d.ok) {
          // 后端返回错误（如强制渠道未配 Key / 抓取失败）：显示错误信息
          this.testError = d.error || "测试失败";
        } else {
          this.testResult = d;
        }
      } catch (e) {
        this.testError = e.message || String(e);
        console.error(e);
      } finally {
        this.testLoading = false;
      }
    },

    clearTest() {
      this.testUrl = "";
      this.testResult = null;
      this.testError = "";
      this.testTab = "md";
    },

    copyMarkdown() {
      const text = this.testResult?.text || "";
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const orig = btn.textContent;
        btn.textContent = "✅ 已复制";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => alert("复制失败，请手动选择文本复制"));
    },

    downloadMarkdown() {
      const text = this.testResult?.text || "";
      if (!text) return;
      const title = (this.testResult?.title || "extracted").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = title + ".md";
      a.click();
      URL.revokeObjectURL(a.href);
    },

    // ========== 配置部署 ==========
    async loadConfig() {
      try {
        const r = await fetch("/api/config?token=" + this.token);
        const d = await r.json();
        if (d.ok) {
          // 渠道定义：按收录流程顺序分组
          const channels = [
            {
              id: "auth", section: "auth", icon: "🔐", title: "收录鉴权", purpose: "Worker 收录接口的 INGEST_TOKEN",
              keys: [
                { name: "INGEST_TOKEN", short: "INGEST_TOKEN", title: "收录鉴权 INGEST_TOKEN", hint: "UUID 或 32 位以上随机字母数字。手机/插件/监控台都用它鉴权", url: "https://www.uuidgenerator.net/" },
              ],
            },
            {
              id: "tikhub", section: "extract", icon: "🔍", title: "TikHub 内容抓取", purpose: "知乎/小红书/B站/微信等平台正文提取",
              keys: [
                { name: "TIKHUB_API_KEY", short: "API Key", title: "TikHub API Key", hint: "在 TikHub 控制台获取", url: "https://tikhub.io/dashboard" },
              ],
            },
            {
              id: "firecrawl", section: "extract", icon: "🌐", title: "Firecrawl 网页抓取", purpose: "兜底网页正文提取（TikHub 不支持的平台）",
              keys: [
                { name: "FIRECRAWL_API_KEY", short: "API Key", title: "Firecrawl API Key", hint: "在 Firecrawl 控制台获取", url: "https://www.firecrawl.dev/" },
              ],
            },
            {
              id: "ocr", section: "extract", icon: "🖼️", title: "火山引擎 OCR", purpose: "小红书图片文字识别（通用文字识别服务）",
              keys: [
                { name: "VOLC_ACCESS_KEY", short: "Access Key ID", title: "火山引擎 Access Key ID", hint: "⚠️ 先开通「通用文字识别 OCR」服务（免费5000次，控制台搜 OCR），再在这里创建 AK：访问控制 → API访问密钥", url: "https://console.volcengine.com/iam/keymanage/" },
                { name: "VOLC_SECRET_KEY", short: "Secret Key", title: "火山引擎 Secret Access Key", hint: "与上面的 Access Key ID 配对使用，注意保密", url: "https://console.volcengine.com/iam/keymanage/" },
              ],
            },
            {
              id: "llm", section: "ai", icon: "🤖", title: "AI 智能分析", purpose: "内容摘要、分类、标签、关键信息提取",
              keys: [
                { name: "ARK_API_KEY", short: "API Key", title: "AI 分析大模型 API Key", hint: "支持 OpenAI 兼容接口的大模型（DeepSeek/OpenAI/通义/豆包等）的 API Key", url: "" },
                { name: "LLM_BASE_URL", short: "Base URL", title: "大模型 API Base URL", hint: "填你所用大模型的 OpenAI 兼容接口地址，如 https://api.deepseek.com（填到域名即可，自动补 /chat/completions）", url: "" },
                { name: "LLM_MODEL", short: "模型名", title: "大模型名称", hint: "填你所用大模型的具体模型名，如 deepseek-chat、gpt-4o 等", url: "" },
              ],
            },
            {
              id: "notion", section: "store", icon: "📝", title: "Notion 知识库", purpose: "收录的内容写入 Notion 数据库",
              keys: [
                { name: "NOTION_API_KEY", short: "Token", title: "Notion 写入 Token", hint: "在 Notion 集成页面创建", url: "https://www.notion.so/profile/integrations" },
                { name: "NOTION_DATABASE_ID", short: "数据库 ID", title: "Notion 数据库 ID", hint: "数据库页面 URL 中间的那段 ID（32位字符串）", url: "https://www.notion.so/" },
              ],
            },
            {
              id: "bark", section: "notify", icon: "🔔", title: "Bark 推送通知", purpose: "iOS 收录完成后推送通知",
              keys: [
                { name: "BARK_KEY", short: "Key", title: "Bark 推送 Key", hint: "打开 Bark App，首页 api.day.app/ 后面那串字符就是 Key", url: "https://apps.apple.com/app/bark/id1623918273" },
              ],
            },
            {
              id: "jina", section: "extract", icon: "⚡", title: "Jina Reader（可选）", purpose: "加速通用网页正文抓取",
              keys: [
                { name: "JINA_API_KEY", short: "API Key", title: "Jina API Key", hint: "在 jina.ai 控制台获取（免费 200 QPM）", url: "https://jina.ai/" },
              ],
            },
          ];

          // 填充配置状态
          for (const ch of channels) {
            for (const k of ch.keys) {
              k.configured = !!d.keys[k.name];
              k.value = "";
              k.msg = "";
              k.msgOk = false;
            }
            ch.allConfigured = ch.keys.every(k => k.configured);
            ch.testing = false;
            ch.testMsg = "";
            ch.testOk = false;
          }
          this.configChannels = channels;
          // 保留 configKeys 兼容旧引用
          this.configKeys = channels.flatMap(ch => ch.keys);
        }
      } catch(e) { console.error(e); }
    },

    openConfigModal(ci) {
      const ch = this.configChannels[ci];
      this.configModal = {
        open: true,
        idx: ci,
        icon: ch.icon,
        title: ch.title,
        purpose: ch.purpose,
        fields: ch.keys.map(k => ({ ...k, value: "", msg: "", msgOk: false })),
        saving: false,
      };
      // AI 智能分析渠道：自动加载提示词
      if (ch.section === "ai") {
        this.loadPrompts();
      }
    },

    closeConfigModal() {
      this.configModal.open = false;
      this.configModal.idx = -1;
    },

    async saveConfigModal() {
      const fields = this.configModal.fields;
      const hasInput = fields.some(f => f.value && f.value.trim());
      if (!hasInput) {
        fields.forEach(f => { if (!f.configured) { f.msg = "请输入值"; f.msgOk = false; } });
        return;
      }
      this.configModal.saving = true;
      const payload = {};
      for (const f of fields) {
        if (f.value && f.value.trim()) payload[f.name] = f.value.trim();
      }
      try {
        const r = await fetch("/api/config?token=" + this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (d.ok) {
          // 更新渠道状态
          const ci = this.configModal.idx;
          for (const f of fields) {
            if (f.value && f.value.trim()) {
              f.configured = true;
              const chKey = this.configChannels[ci].keys.find(k => k.name === f.name);
              if (chKey) chKey.configured = true;
            }
            f.value = "";
          }
          this.configChannels[ci].allConfigured = this.configChannels[ci].keys.every(k => k.configured);
          this.configModal.saving = false;
          this.closeConfigModal();
        } else {
          fields.forEach(f => { f.msg = "❌ " + (d.error || "保存失败"); f.msgOk = false; });
          this.configModal.saving = false;
        }
      } catch (e) {
        fields.forEach(f => { f.msg = "❌ " + e.message; f.msgOk = false; });
        this.configModal.saving = false;
      }
    },

    async testChannel(ci) {
      const ch = this.configChannels[ci];
      ch.testing = true; ch.testMsg = "";
      try {
        // 测试渠道第一个 key（主 key）
        const mainKey = ch.keys[0];
        const r = await fetch("/api/config-test?token=" + this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: mainKey.name, value: mainKey.value || "" }),
        });
        const d = await r.json();
        if (d.ok) {
          ch.testMsg = "✅ " + (d.message || "测试通过");
          ch.testOk = true;
        } else {
          ch.testMsg = "❌ " + (d.error || d.message || "测试失败");
          ch.testOk = false;
        }
      } catch (e) {
        ch.testMsg = "❌ " + e.message;
        ch.testOk = false;
      } finally {
        ch.testing = false;
        setTimeout(() => { ch.testMsg = ""; }, 6000);
      }
    },

    // ========== 提示词 ==========
    async loadPrompts() {
      try {
        const r = await fetch("/api/prompts?token=" + this.token);
        const d = await r.json();
        if (d.ok) {
          this.promptForm.system_prompt = d.system_prompt || "";
          this.promptForm.user_template = d.user_template || "";
        }
      } catch(e) { console.error(e); }
    },

    async savePrompts() {
      this.promptsSaving = true;
      this.promptsSaved = false;
      try {
        const r = await fetch("/api/prompts?token=" + this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.promptForm)
        });
        const d = await r.json();
        if (d.ok) {
          this.promptsSaved = true;
          setTimeout(() => { this.promptsSaved = false; }, 3000);
        } else {
          alert("保存失败：" + (d.error || "unknown"));
        }
      } catch(e) {
        alert("保存失败：" + e.message);
      } finally {
        this.promptsSaving = false;
      }
    },

    async resetPrompts() {
      if (!confirm("恢复默认提示词？当前编辑的内容将被覆盖。")) return;
      try {
        const r = await fetch("/api/prompts?token=" + this.token + "&default=1");
        const d = await r.json();
        if (d.ok) {
          this.promptForm.system_prompt = d.system_prompt || "";
          this.promptForm.user_template = d.user_template || "";
        }
      } catch(e) { console.error(e); }
    },

    async testPrompt() {
      if (!this.promptTest.text.trim()) {
        alert("请输入测试正文");
        return;
      }
      this.promptTesting = true;
      this.promptTestResult = null;
      this.promptTestError = "";
      try {
        const r = await fetch("/api/prompt-test?token=" + this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system_prompt: this.promptForm.system_prompt,
            user_template: this.promptForm.user_template,
            title: this.promptTest.title,
            source_platform: this.promptTest.source_platform,
            text: this.promptTest.text,
          })
        });
        const d = await r.json();
        if (d.ok) {
          this.promptTestResult = d;
        } else {
          this.promptTestError = d.error || "测试失败";
        }
      } catch(e) {
        this.promptTestError = e.message;
      } finally {
        this.promptTesting = false;
      }
    }
  };
}
</script>
</body>
</html>`;
