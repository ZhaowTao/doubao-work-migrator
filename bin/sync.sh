#!/usr/bin/env bash
# ============================================================
# 豆包Work → 本地 Markdown / WorkBuddy / Hermes 一键同步
# 用法: ./bin/sync.sh [--full]
#   --full  忽略本地缓存，重拉全部对话
# 依赖: node >= 18（自带 WebSocket）、python3、豆包Work 桌面客户端（已登录）
# 平台: macOS（依赖 CDP 端口 + LaunchServices 启动方式）
# 可配置环境变量（均有默认值，不设即可）:
#   DOUBAO_OUT_DIR        Markdown 归档根目录  默认 ~/WorkBuddy/豆包Work导入
#   DOUBAO_WORK_DIR       中间产物与增量缓存    默认 ~/.doubao-migrator
#   DOUBAO_APP            客户端路径            默认 /Applications/DoubaoWork.app
#   WORKBUDDY_MEM_FILE    WorkBuddy 记忆落点     默认 ~/.workbuddy/memory/doubao-import_memory.md
#   HERMES_MEM_FILE       Hermes 记忆落点        默认 ~/.hermes/memories/MEMORY.md
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${DOUBAO_WORK_DIR:-$HOME/.doubao-migrator}"
APP="${DOUBAO_APP:-/Applications/DoubaoWork.app}"
APP_BIN="$APP/Contents/MacOS/DoubaoWork"
SUPPORT="$HOME/Library/Application Support/DoubaoWork"

command -v node >/dev/null || { echo "需要 node >= 18"; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
[[ -x "$APP_BIN" ]] || { echo "找不到豆包Work: $APP_BIN"; exit 1; }

mkdir -p "$WORK/export" "$WORK/logs" "$WORK/lib"
# 脚本与工作目录分离：src 从仓库读，产物与中间缓存写工作目录
for f in refresh_index.js extract_messages.js extract_memories.js extract_skills.js convert.py place_to_folders.py; do
  cp -f "$ROOT/src/$f" "$WORK/$f"
done
cp -f "$ROOT/src/lib/cdp.js" "$WORK/lib/cdp.js"

# 本机代理会拦截 127.0.0.1，务必清掉
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true

restore_app() {
  pkill -f "$APP/Contents" 2>/dev/null || true
  sleep 2
  rm -f "$SUPPORT/SingletonLock" "$SUPPORT/SingletonSocket" 2>/dev/null || true
  open -a "$APP" 2>/dev/null || true
}

# 只杀主进程不够：Helper / Browser 子进程残留时，新实例会复用旧进程，
# --remote-debugging-port 静默不生效（实测踩过，表现为 CDP 一直连不上）。
kill_app() {
  pkill -f "$APP/Contents" 2>/dev/null || true
  sleep 3
  rm -f "$SUPPORT/SingletonLock" "$SUPPORT/SingletonSocket" 2>/dev/null || true
}

start_with_cdp() {
  nohup "$APP_BIN" --remote-debugging-port=9222 >"$WORK/logs/dw_sync.log" 2>&1 &
  for i in $(seq 1 15); do
    sleep 2
    curl -s --noproxy '*' --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && return 0
  done
  return 1
}

trap restore_app EXIT

echo "== 1/7 启动豆包Work（挂 CDP 9222）"
kill_app
if ! start_with_cdp; then
  echo "   首次没起来，清掉残留进程重试一次"
  kill_app
  start_with_cdp || { echo "   CDP 启动失败，见 $WORK/logs/dw_sync.log"; exit 1; }
fi
echo "   CDP 就绪"

cd "$WORK"

echo "== 2/7 刷新对话索引"
node refresh_index.js

echo "== 3/7 增量拉取对话消息"
[[ "${1:-}" == "--full" ]] && { rm -f "$WORK/export/all_messages.json"; echo "   --full：已清空本地消息缓存"; }
node extract_messages.js

echo "== 4/7 拉取个人记忆"
node extract_memories.js

echo "== 5/7 拉取技能清单"
node extract_skills.js || echo "   技能接口失败，跳过"

echo "== 6/7 生成归档与转录"
python3 convert.py
python3 place_to_folders.py

echo "== 7/7 恢复豆包Work"
restore_app
trap - EXIT
sleep 3
if curl -s --noproxy '*' --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "   ！调试端口仍在（pkill 可能被权限拦截），手动执行："
  echo "     pkill -f '$APP/Contents'; rm -f '$SUPPORT/SingletonLock'; open -a '$APP'"
else
  echo "   已恢复正常"
fi
