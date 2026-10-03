#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 重启权限配置（仅 systemd 部署需要，执行一次即可）
#
#  用途：管理后台的「版本更新」在更新代码后需要重启服务。
#        当服务由 systemd 托管、且运行用户不是 root 时，普通用户无权执行
#        `systemctl restart lczoj`，此时更新会提示「请手动执行 sudo systemctl restart lczoj」。
#        运行本脚本可为服务运行用户配置**最小权限**的 sudo 规则，
#        使其今后只需重启本服务时无需输入密码（其他 systemctl 操作仍不允许）。
#
#  用法（需要 root）：
#      sudo bash deploy/grant-restart-permission.sh
#      sudo bash deploy/grant-restart-permission.sh --user www      # 指定服务运行用户
#      sudo bash deploy/grant-restart-permission.sh --unit lczoj    # 指定服务单元名
#      sudo bash deploy/grant-restart-permission.sh --remove        # 撤销该权限
# =============================================================================
set -e

UNIT="lczoj"
USER_NAME=""
REMOVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --unit) UNIT="${2:-}"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "错误：请使用 root 执行，例如：sudo bash deploy/grant-restart-permission.sh" >&2
  exit 1
fi

SUDOERS_FILE="/etc/sudoers.d/lczoj-restart"

if [ "$REMOVE" = "1" ]; then
  if [ -f "$SUDOERS_FILE" ]; then
    rm -f "$SUDOERS_FILE"
    echo "已撤销重启权限配置（$SUDOERS_FILE）"
  else
    echo "未发现配置（$SUDOERS_FILE），无需撤销"
  fi
  exit 0
fi

# 自动识别服务运行用户：优先取 systemd 单元里的 User=，其次取单元文件属主，最后取当前项目目录属主
if [ -z "$USER_NAME" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    USER_NAME="$(systemctl show -p User --value "$UNIT" 2>/dev/null | head -n1)"
  fi
  if [ -z "$USER_NAME" ] && [ -f "/etc/systemd/system/${UNIT}.service" ]; then
    USER_NAME="$(sed -n 's/^User=//p' "/etc/systemd/system/${UNIT}.service" | head -n1)"
  fi
  if [ -z "$USER_NAME" ]; then
    USER_NAME="$(stat -c '%U' "$(cd "$(dirname "$0")/.." && pwd)" 2>/dev/null || true)"
  fi
fi

if [ -z "$USER_NAME" ] || [ "$USER_NAME" = "root" ]; then
  echo "提示：服务以 root 运行或无法识别运行用户，无需配置重启权限。"
  echo "      如仍无法自动重启，请检查 deploy/lczoj.service 中的 User= 设置。"
  exit 0
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "错误：用户 $USER_NAME 不存在（可用 --user 指定）" >&2
  exit 1
fi

SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"

cat > "$SUDOERS_FILE" <<EOF
# LCZOJ：允许服务运行用户重启（及查询）本服务，便于管理后台一键更新后自动重启
# 生成时间：$(date '+%Y-%m-%d %H:%M:%S')　服务单元：${UNIT}.service
${USER_NAME} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart ${UNIT}, ${SYSTEMCTL} start ${UNIT}, ${SYSTEMCTL} stop ${UNIT}, ${SYSTEMCTL} is-active ${UNIT}
EOF

chmod 0440 "$SUDOERS_FILE"

# 语法校验：不通过则立即回滚，避免 sudo 配置损坏
if command -v visudo >/dev/null 2>&1; then
  if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
    rm -f "$SUDOERS_FILE"
    echo "错误：sudoers 语法校验未通过，已回滚，未做任何修改。" >&2
    exit 1
  fi
fi

echo "已为服务运行用户 [$USER_NAME] 配置重启权限："
echo "  $SUDOERS_FILE"
echo "  允许：sudo -n ${SYSTEMCTL} restart|start|stop|is-active ${UNIT}"
echo ""
echo "现在可以在「管理后台 → 系统设置 → 版本更新」中一键更新，服务会自动重启。"
echo "如需撤销：sudo bash deploy/grant-restart-permission.sh --remove"
