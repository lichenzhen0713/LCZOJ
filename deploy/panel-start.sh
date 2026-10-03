#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 前台启动脚本（宝塔 / 小皮 / PM2 / supervisor / systemd 通用）
#
#  作用：读取 deploy/panel.env（如果存在）→ 检查环境 → 前台启动服务
#        「前台启动」很关键：进程守护工具需要一直盯着这个进程，
#        脚本退出 = 服务停止，它们才能自动重启。
#
#  用法：
#    bash deploy/panel-start.sh
#    宝塔：网站 → Node 项目 → 启动命令填 bash deploy/panel-start.sh
#    小皮：计划任务/进程守护 → 启动命令填 bash deploy/panel-start.sh
#    PM2 ：pm2 start deploy/ecosystem.config.js   （等价，参数写在配置里）
# =============================================================================
set -e

cd "$(dirname "$0")/.."

# 1) 读取面板环境变量文件（存在才读）
if [ -f deploy/panel.env ]; then
  set -a
  # shellcheck disable=SC1091
  . deploy/panel.env
  set +a
  echo "[LCZOJ] 已加载 deploy/panel.env"
fi

# 2) 默认值（panel.env 里没写的用这里）
export PORT="${PORT:-3000}"
export OJ_HOST="${OJ_HOST:-127.0.0.1}"
export OJ_MAX_JUDGES="${OJ_MAX_JUDGES:-4}"
export NODE_ENV="${NODE_ENV:-production}"
export TZ="${TZ:-Asia/Shanghai}"

# 3) 基础检查：Node 存在、版本够用
if ! command -v node >/dev/null 2>&1; then
  echo "[LCZOJ] 错误：找不到 node 命令。请先在面板里安装 Node.js v24（或 ≥ v22.5）。" >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "[LCZOJ] 错误：Node.js 版本过低（当前 $(node -v)），需要 ≥ v22.5，推荐 v24。" >&2
  exit 1
fi

echo "[LCZOJ] 启动中：监听 ${OJ_HOST}:${PORT}，数据目录 ${OJ_DATA_DIR:-$PWD/data}，并行判题 ${OJ_MAX_JUDGES}"

# 4) 前台启动（exec 让 SIGTERM 直接送达 node，面板「停止/重启」才能优雅退出）
exec node server.js
