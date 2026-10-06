#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 一行部署引导脚本（GitHub / Gitee）
#
#  在【全新】的 Linux 服务器上执行下面【一条命令】即可完成部署：
#
#   仓库在 GitHub：
#     curl -fsSL https://raw.githubusercontent.com/<你的账号>/LCZOJ/master/bootstrap.sh | sudo bash
#
#   仓库在 Gitee（码云）：
#     curl -fsSL https://gitee.com/<你的账号>/LCZOJ/raw/master/bootstrap.sh | sudo bash
#
#  脚本会自动：
#    1) 安装基础工具（curl / git / tar / unzip）
#    2) 从仓库下载 LCZOJ 到 /opt/lczoj（GitHub 优先，Gitee 自动回退）
#    3) 识别发行版并执行对应的专用安装脚本（Ubuntu/Debian、CentOS/RHEL、其它）
#    4) 安装 Node.js、全部评测语言编译器，注册 systemd 开机自启，
#       放行防火墙 80 端口，启动网站并输出外网访问地址
#
#  仓库地址可通过环境变量覆盖：
#    LCZOJ_REPO=https://github.com/你的账号/LCZOJ
#    LCZOJ_GITEE=https://gitee.com/你的账号/LCZOJ
#    示例：sudo LCZOJ_REPO=... bash -c "$(curl -fsSL <脚本地址>)"
# =============================================================================
set -e

: "${LCZOJ_REPO:=https://github.com/lichenzhen0713/LCZOJ}"
: "${LCZOJ_GITEE:=https://gitee.com/lichenzhen0713/LCZOJ}"
DEST=/opt/lczoj

echo "=============================================="
echo "  LCZOJ 一行部署"
echo "=============================================="

# ---------------- 1. 安装基础工具 ----------------
echo "安装基础工具（curl / git / tar / unzip）…"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl git tar unzip >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl git tar unzip >/dev/null 2>&1 || true
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl git tar unzip >/dev/null 2>&1 || true
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm curl git tar unzip >/dev/null 2>&1 || true
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl git tar unzip >/dev/null 2>&1 || true
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive install curl git tar unzip >/dev/null 2>&1 || true
fi

# ---------------- 2. 下载项目 ----------------
# 非交互克隆：当 GitHub 仓库需要登录（私有 / 不存在）时 git 会提示输入账号，
# 提示走 /dev/tty，> /dev/null 屏蔽不掉，会一直卡在 "Username for 'https://github.com':"。
# 设置 GIT_TERMINAL_PROMPT=0 后 git 直接失败，自动走 Gitee 回退，不再阻塞。
export GIT_TERMINAL_PROMPT=0
if [ -f "$DEST/server.js" ]; then
  echo "项目已存在于 $DEST，正在更新…"
  (cd "$DEST" && GIT_TERMINAL_PROMPT=0 git pull) >/dev/null 2>&1 || true
else
  mkdir -p /opt
  echo "从仓库下载 LCZOJ → $DEST"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$LCZOJ_REPO" "$DEST" >/dev/null 2>&1 \
      || git clone --depth 1 "$LCZOJ_GITEE" "$DEST" >/dev/null 2>&1 \
      || true
  fi
  if [ ! -f "$DEST/server.js" ]; then
    echo "Git 克隆失败，改用压缩包下载…"
    curl -fsSL "${LCZOJ_REPO}/archive/refs/heads/master.tar.gz" -o /tmp/lczoj-dl.tar.gz 2>/dev/null \
      || curl -fsSL "${LCZOJ_GITEE}/repository/archive/master.zip" -o /tmp/lczoj-dl.zip 2>/dev/null \
      || { echo "错误：下载项目失败，请检查仓库地址（LCZOJ_REPO / LCZOJ_GITEE）。" >&2; exit 1; }
    # M18：下载后先校验 SHA256 再解包执行（LCZOJ_REPO_SHA256 可固定期望值；
    # 未配置时打印显著警告 + 实际哈希，仓库压缩包一旦被替换至少留下可核对指纹）
    PKG=/tmp/lczoj-dl.tar.gz
    [ -f "$PKG" ] || PKG=/tmp/lczoj-dl.zip
    GOT=$(sha256sum "$PKG" 2>/dev/null | awk '{print $1}')
    if [ -n "${LCZOJ_REPO_SHA256:-}" ]; then
      if [ "$GOT" != "$LCZOJ_REPO_SHA256" ]; then
        echo "错误：项目包 SHA256 校验失败！期望 $LCZOJ_REPO_SHA256，实际 $GOT" >&2
        echo "      已拒绝解包执行（仓库更新或被篡改，请人工确认）。" >&2
        rm -f "$PKG"; exit 1
      fi
      echo "   ✓ 项目包 SHA256 校验通过（$GOT）"
    else
      echo "   ⚠ 未提供 LCZOJ_REPO_SHA256，无法校验项目包完整性！实际 SHA256 = ${GOT:-（计算失败）}"
      echo "     建议确认无误后用该值固定：LCZOJ_REPO_SHA256=$GOT"
    fi
    if [ -f /tmp/lczoj-dl.tar.gz ]; then
      tar -xzf /tmp/lczoj-dl.tar.gz -C /opt
      mv /opt/LCZOJ-main "$DEST" 2>/dev/null || mv /opt/lczoj-main "$DEST" 2>/dev/null || true
    else
      unzip -qo /tmp/lczoj-dl.zip -d /opt
      mv /opt/LCZOJ-main "$DEST" 2>/dev/null || mv /opt/lczoj-main "$DEST" 2>/dev/null || true
    fi
    rm -f /tmp/lczoj-dl.tar.gz /tmp/lczoj-dl.zip
  fi
fi
[ -f "$DEST/server.js" ] || { echo "错误：未能取得项目文件（server.js 不存在）。" >&2; exit 1; }
echo "项目就绪: $DEST ✓"

# ---------------- 3. 识别发行版并执行对应安装脚本 ----------------
cd "$DEST"
if command -v apt-get >/dev/null 2>&1; then
  echo "检测到 Debian/Ubuntu 系 → 使用 install-ubuntu.sh"
  bash "$DEST/install-ubuntu.sh"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  echo "检测到 CentOS/RHEL 系 → 使用 install-centos.sh"
  bash "$DEST/install-centos.sh"
else
  echo "其它发行版 → 使用通用 install.sh（--daemon）"
  bash "$DEST/install.sh" --daemon
fi
