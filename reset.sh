#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 恢复默认状态（Linux / macOS 入口）
#
#  本脚本只是 deploy/reset.js 的快捷入口，所有逻辑都在 Node 里实现，
#  因此 Windows / Linux 行为完全一致，脚本也可从任意目录执行。
#
#  用法：
#    ./reset.sh              停止服务并清空数据（会先询问确认）
#    ./reset.sh --yes        不询问，直接执行
#    ./reset.sh --check      只显示将要执行的操作，不做任何修改
#    ./reset.sh --start      清空后前台启动（Ctrl+C 停止）
#    ./reset.sh --daemon     清空后后台启动（日志 logs/lczoj.log）
#    ./reset.sh --port 8080  指定端口（默认 80，也可用 PORT 环境变量）
#    ./reset.sh --help       查看完整帮助
#
#  说明：删除范围仅为数据目录（默认 <项目目录>/data，可用 OJ_DATA_DIR 指定），
#        程序代码与配置不受影响；清空后首次启动会重建 admin 账号与 3 道示例题。
# =============================================================================
set -e

# 切到脚本所在目录（无论从哪里调用都能正确定位项目）
cd "$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[LCZOJ] 未找到 node 命令，请先安装 Node.js 22.5+（推荐 v24）：https://nodejs.org/zh-cn/download" >&2
  exit 1
fi

exec node deploy/reset.js "$@"
