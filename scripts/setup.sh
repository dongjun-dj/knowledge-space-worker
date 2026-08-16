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
# 0. 环境检查
# ─────────────────────────────────────────────
command -v node >/dev/null 2>&1 || warn "未检测到 Node.js，请先安装：https://nodejs.org/（须 18+）"
command -v npx >/dev/null 2>&1 || fail "未检测到 npx，请确认 Node.js 安装完整。"
npx wrangler --version >/dev/null 2>&1 || fail "未安装 wrangler，请先执行：npm i -g wrangler"

# ─────────────────────────────────────────────
# 1. 登录检查（未登录会自动弹出浏览器授权）
# ─────────────────────────────────────────────
echo ""
info "检查 Cloudflare 登录状态（若未登录会弹出浏览器授权）…"
npx wrangler whoami >/dev/null 2>&1 || fail "登录失败，请手动执行 npx wrangler login"
ok "Cloudflare 登录正常"

# ─────────────────────────────────────────────
# 2. 创建 D1 数据库（已存在则跳过）并抓取 ID
# ─────────────────────────────────────────────
echo ""
DB_NAME="kb-logs"
echo "📦 检查数据库 $DB_NAME …"

DBID="$(npx wrangler d1 info "$DB_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [ -n "$DBID" ]; then
  ok "数据库已存在，ID: $DBID"
else
  info "数据库不存在，正在创建…"
  CREATE_OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1)"
  DBID="$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  [ -n "$DBID" ] || fail "创建数据库失败，无法获取 ID。输出：$CREATE_OUT"
  ok "数据库创建成功，ID: $DBID"
fi

# ─────────────────────────────────────────────
# 3. 把数据库 ID 写入 wrangler.toml
# ─────────────────────────────────────────────
echo ""
if grep -q "database_id = \"$DBID\"" wrangler.toml; then
  ok "wrangler.toml 中的 database_id 已是最新，跳过"
else
  sed -i '' "s|database_id = \"[^\"]*\"|database_id = \"$DBID\"|" wrangler.toml
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

# ─────────────────────────────────────────────
# 6. 令牌 + 部署
# ─────────────────────────────────────────────
echo ""
# 只在"从未设置过令牌"时才生成新令牌；已有令牌则保留，避免破坏现有配置
if npx wrangler secret list 2>&1 | grep -q 'INGEST_TOKEN'; then
  TOKEN=""
  warn "检测到已存在访问令牌，保留不重置（避免已有插件/快捷指令失效）。如需重置，请先删除该密钥。"
  info "开始部署…"
else
  info "首次部署，生成访问令牌…"
  TOKEN="$(openssl rand -hex 16)"
  printf '%s' "$TOKEN" | npx wrangler secret put INGEST_TOKEN >/dev/null 2>&1 && ok "新令牌已写入 Cloudflare" || fail "令牌设置失败"
fi

DEPLOY_OUT="$(npx wrangler deploy 2>&1)"
URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
[ -n "$URL" ] || { echo "$DEPLOY_OUT" >&2; fail "部署失败"; }

# 令牌为空（保留已有密钥时取不到明文），则提示从已有配置获取
if [ -z "$TOKEN" ]; then
  echo ""
  echo "══════════════════════════════════════════════════"
  ok "部署完成！"
  echo "  访问地址:  ${URL}/admin"
  echo "  访问令牌:  (保留原有令牌，请在已有配置中获取)"
  echo "══════════════════════════════════════════════════"
  echo ""
  warn "本次未生成新令牌，继续使用你之前的访问令牌。配置页面 URL：${URL}/admin?token=<你之前保存的令牌>"
else
  echo ""
  echo "══════════════════════════════════════════════════"
  ok "部署完成！"
  echo "  访问地址:  ${URL}/admin?token=${TOKEN}"
  echo "  访问令牌:  ${TOKEN}"
  echo "══════════════════════════════════════════════════"
  echo ""
  warn "请妥善保存上面的访问令牌！后续登录配置页、配置手机快捷指令和 Chrome 插件都要用。丢了只能重新部署生成。"
fi
