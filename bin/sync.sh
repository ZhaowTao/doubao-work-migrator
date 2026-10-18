#!/bin/zsh
# ============================================================
# doubao-work-migrator 一键增量同步
# 用法: bin/sync.sh [--full]
#   --full  忽略已有中间产物，全量重提（慎用）
# 流程: 重启豆包Work挂CDP → 刷新索引 → 增量提取新对话消息
#       → 重新生成归档/摘要/Hermes记忆 → 放置到项目文件夹
#       → 重启豆包Work恢复正常状态
# ============================================================
set -e

MIG_HOME="${MIG_HOME:-$HOME/doubao-work-migrator}"
WORK_DIR="${WORK_DIR:-$HOME/.doubao-migrator}"     # 中间产物目录
NODE="${NODE:-$(command -v node || echo /usr/local/bin/node)}"
PY="${PY:-$(command -v python3 || echo /usr/bin/python3)}"
APP="${APP:-/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork}"
CDP_PORT="${CDP_PORT:-9222}"
FULL=0
[[ "$1" == "--full" ]] && FULL=1

mkdir -p "$WORK_DIR"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
cd "$MIG_HOME/src"

echo "== 1/6 重启豆包Work（挂 CDP :$CDP_PORT）"
pkill -f "DoubaoWork" 2>/dev/null || true
sleep 3
rm -f ~/Library/Application\ Support/DoubaoWork/SingletonLock ~/Library/Application\ Support/DoubaoWork/SingletonSocket 2>/dev/null || true
nohup "$APP" --remote-debugging-port="$CDP_PORT" >/tmp/doubao-work-migrator.log 2>&1 &
for i in $(seq 1 15); do
  sleep 2
  curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
done
curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && echo "   CDP 就绪" || { echo "   CDP 启动失败，查看 /tmp/doubao-work-migrator.log"; exit 1; }

echo "== 2/6 刷新对话索引（项目 + 最近 50 + 归档）"
[[ $FULL -eq 1 ]] && rm -f "$WORK_DIR/conv_index.json" "$WORK_DIR/all_messages.json"
"$NODE" refresh_index.js

echo "== 3/6 增量提取新对话消息（已有点评会跳过）"
"$NODE" extract_messages.js

echo "== 4/6 重新生成归档与摘要"
"$PY" convert.py
"$PY" place_to_folders.py

echo "== 5/6 重启豆包Work（恢复正常状态）"
pkill -f "DoubaoWork" 2>/dev/null || true
sleep 3
rm -f ~/Library/Application\ Support/DoubaoWork/SingletonLock ~/Library/Application\ Support/DoubaoWork/SingletonSocket 2>/dev/null || true
open -a /Applications/DoubaoWork.app

echo "== 6/6 完成"
echo "总览: $HOME/WorkBuddy/豆包Work导入/豆包Work资产导入_总览.md"
echo "提示: 豆包个人记忆的增删不在 API 内，请在 设置→记忆 面板人工核对"
