#!/bin/sh
# =============================================================================
#  LCZOJ Docker 入口脚本
#  职责：
#    1) 确认数据目录存在且可写（挂载卷默认属主是 root，这里改回镜像自带的 node 用户）
#    2) 以非 root 用户 node（UID/GID 1000）启动服务：判题会执行用户提交的代码，降权更安全
#    3) 用 exec 交棒，保证 SIGTERM 直接送到 node 进程
#       —— docker stop / 宝塔 / 小皮的「停止」都依赖这一点做优雅退出
# =============================================================================
set -e

DATA_DIR="${OJ_DATA_DIR:-/app/data}"
PORT="${PORT:-80}"

mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  # 修正挂载卷属主（宿主机 bind mount 常见问题：目录属主是 root，程序写不进去）
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  echo "[LCZOJ] 数据目录: $DATA_DIR（已确保属主为 node / UID 1000）"
  echo "[LCZOJ] 监听端口: $PORT"
  exec gosu node "$@"
fi

# 已经是普通用户（例如 docker run --user 1000:1000）
if [ ! -w "$DATA_DIR" ]; then
  echo "[LCZOJ] 警告：数据目录 $DATA_DIR 不可写，数据库与测试数据将无法保存。"
  echo "        请检查挂载卷权限，或去掉 --user 参数让入口脚本自动修正属主。"
fi
exec "$@"
