#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  知识空间 Worker —— 一键部署脚本
#  会自动完成：创建数据库 → 写入配置 → 创建队列 → 建表 → 部署
#  使用：bash setup.sh
#  ⚠️ 已配置过的内容会自动跳过（幂等），可放心重复运行
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# 颜色
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
info() { echo -e "${BLUE}ℹ️  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail() { echo -e "${RED}❌ $*${NC}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"
echo "📂 项目目录: $PROJECT_DIR"

# ─────────────────────────────────────────────
# 0. 平台检测
# ─────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin)   PLATFORM="macOS" ;;
  Linux)    PLATFORM="Linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="Windows(Git Bash)" ;;
  *)        PLATFORM="未知($OS)" ;;
esac
echo "🖥️  运行平台: $PLATFORM"
# macOS 的 sed 需要 -i ''（BSD sed），Linux 用 -i（GNU sed）
if [[ "$PLATFORM" == "macOS" ]]; then
  SED_INLINE=("sed" "-i" "")
else
  SED_INLINE=("sed" "-i")
fi

# ─────────────────────────────────────────────
# 0. 环境检查
# ─────────────────────────────────────────────
command -v node >/dev/null 2>&1 || warn "未检测到 Node.js，请先安装：https://nodejs.org/（须 18+）"
command -v npx >/dev/null 2>&1 || fail "未检测到 npx，请确认 Node.js 安装完整。"
npx wrangler --version >/dev/null 2>&1 || fail "未安装 wrangler，请先执行：npm i -g wrangler"

# ─────────────────────────────────────────────
# 1. 登录检查（未登录会自动弹出浏览器授权）
# ─────────────────────────────────────────────
echo ""
info "检查 Cloudflare 登录状态（未登录会自动弹出浏览器授权）…"
if ! npx wrangler whoami >/dev/null 2>&1; then
  warn "未登录 Cloudflare，正在打开浏览器让你授权登录…"
  npx wrangler login || fail "登录失败，请手动执行：npx wrangler login"
  echo ""
  info "登录完成，重新确认…"
  npx wrangler whoami >/dev/null 2>&1 || fail "登录仍未生效，请手动执行：npx wrangler login"
fi
ok "Cloudflare 登录正常"

# ─────────────────────────────────────────────
# 2. 创建 D1 数据库（已存在则跳过）并抓取 ID
# ─────────────────────────────────────────────
echo ""
DB_NAME="kb-logs"
echo "📦 检查数据库 $DB_NAME …"

DBID="$(npx wrangler d1 list 2>/dev/null | grep "$DB_NAME" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [ -n "$DBID" ]; then
  ok "数据库已存在，ID: $DBID"
else
  info "数据库不存在，正在创建…"
  CREATE_OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)"
  DBID="$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  # 若 create 报"已存在"（说明并发建过），则从 list 再取一次 ID
  if [ -z "$DBID" ] && echo "$CREATE_OUT" | grep -qi 'already exists'; then
    DBID="$(npx wrangler d1 list 2>/dev/null | grep "$DB_NAME" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
    ok "数据库已存在，ID: $DBID"
  fi
  [ -n "$DBID" ] || fail "创建数据库失败，无法获取 ID。输出：$CREATE_OUT"
  [ "$DBID" ] && ok "数据库就绪，ID: $DBID"
fi

# ─────────────────────────────────────────────
# 3. 把数据库 ID 写入 wrangler.toml
# ─────────────────────────────────────────────
echo ""
if grep -q "database_id = \"$DBID\"" wrangler.toml; then
  ok "wrangler.toml 中的 database_id 已是最新，跳过"
else
  "${SED_INLINE[@]}" "s|database_id = \"[^\"]*\"|database_id = \"$DBID\"|" wrangler.toml
  ok "已把 database_id 写入 wrangler.toml"
fi

# ─────────────────────────────────────────────
# 4. 创建消息队列（已存在则跳过）
# ─────────────────────────────────────────────
echo ""
QUEUE="ingest-tasks"
echo "📨 检查消息队列 $QUEUE …"
if npx wrangler queues list 2>/dev/null | grep -q "$QUEUE"; then
  ok "队列已存在，跳过"
else
  npx wrangler queues create "$QUEUE" >/dev/null 2>&1 && ok "队列创建成功" || warn "队列创建失败（可能已存在），继续"
fi

# ─────────────────────────────────────────────
# 5. 初始化数据库表（幂等，重复执行无副作用）
# ─────────────────────────────────────────────
echo ""
echo "🗄️  初始化数据库表…"
[ -f schema.sql ]         && npx wrangler d1 execute "$DB_NAME" --file=schema.sql         >/dev/null 2>&1 && ok "日志表已就绪"         || warn "schema.sql 执行异常"
[ -f schema-async.sql ]   && npx wrangler d1 execute "$DB_NAME" --file=schema-async.sql   >/dev/null 2>&1 && ok "异步任务表已就绪"     || warn "schema-async.sql 执行异常"
[ -f schema-config.sql ]  && npx wrangler d1 execute "$DB_NAME" --file=schema-config.sql  >/dev/null 2>&1 && ok "配置表已就绪"         || warn "schema-config.sql 执行异常"

# ─────────────────────────────────────────────
# 6. 令牌 + 部署
# ─────────────────────────────────────────────
echo ""
# 只在"从未设置过令牌"时才生成新令牌；已有令牌则保留，避免破坏现有配置
if npx wrangler secret list 2>&1 | grep -q 'INGEST_TOKEN'; then
  TKN=""
  warn "检测到已存在 INGEST_TOKEN，保留不重置（避免已有插件/快捷指令失效）。如需重置，请先删除该密钥。"
  info "开始部署…"
else
  info "首次部署，生成 INGEST_TOKEN…"
  # 用 node 生成随机令牌（跨平台稳定，避免 Windows 上 openssl 差异）
  TKN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
  if [ -z "$TKN" ]; then
    fail "生成令牌失败（node 未输出）。请确认 Node.js 安装正常。"
  fi
  if printf '%s' "$TKN" | npx wrangler secret put INGEST_TOKEN; then
    ok "新令牌已写入 Cloudflare"
    # 打印并把令牌保存到本地文件（用户随时可读）
    echo "  🔑 INGEST_TOKEN: $TKN"
    printf "INGEST_TOKEN=%s\n" "$TKN" > .secrets.local
    echo "  📄 已保存到本地文件 .secrets.local（可用 cat .secrets.local 查看）"
  else
    fail "令牌设置失败，请手动执行：printf '$TKN' | npx wrangler secret put INGEST_TOKEN"
  fi
fi

# 部署（如果账号没注册 workers.dev 子域名，deploy 会报错提示）
echo ""
info "开始部署…"
DEPLOY_OUT="$(npx wrangler deploy 2>&1 </dev/null || true)"
# 检查是否因子域名未注册而失败
if echo "$DEPLOY_OUT" | grep -qi 'register a workers.dev subdomain'; then
  echo "$DEPLOY_OUT" >&2
  echo ""
  fail "检测到你的 Cloudflare 账号尚未注册 workers.dev 子域名，无法发布 Worker。
请先在浏览器打开以下链接，按提示注册一个子域名（一个账号只需注册一次），然后重新运行本脚本：
  https://dash.cloudflare.com/  -> 登录 -> Workers & Pages -> 按提示设置子域名

子域名建议用你的个人/品牌标识（如名字缩写），不要用项目名，因为它是账号级共用的。"
fi
URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
[ -n "$URL" ] || { echo "$DEPLOY_OUT" >&2; fail "部署失败"; }

# 令牌为空（保留已有密钥时取不到明文），则提示从已有配置获取
if [ -z "$TKN" ]; then
  echo ""
  echo "══════════════════════════════════════════════════"
  ok "已完成部署！"
  echo ""
  echo "  Worker URL: ${URL}"
  echo "  INGEST_TOKEN: 请查看本地文件 .secrets.local（cat .secrets.local）"
  echo ""
  echo "  请访问: ${URL}/admin?token=<你保存的令牌>  完成后续配置"
  echo ""
  warn "请妥善保管令牌，后续登录配置页面、手机快捷指令、Chrome 插件都会用到。"
  echo "══════════════════════════════════════════════════"
  echo ""
else
  echo ""
  echo "══════════════════════════════════════════════════"
  ok "已完成部署！"
  echo ""
  echo "  Worker URL: ${URL}"
  echo "  INGEST_TOKEN: ${TKN}"
  echo ""
  echo "  请访问: ${URL}/admin?token=${TKN}  完成后续配置"
  echo ""
  warn "请妥善保管令牌，后续登录配置页面、手机快捷指令、Chrome 插件都会用到。"
  echo "══════════════════════════════════════════════════"
  echo ""
fi
