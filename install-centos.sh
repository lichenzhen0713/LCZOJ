#!/usr/bin/env bash
# =============================================================================
#  LCZOJ - CentOS / RHEL 一键部署脚本（全新系统直接可用，支持 CentOS 7/8/9）
#
#  用法（在全新 CentOS/RHEL 服务器上）：
#    方式一（推荐，一条命令，无需上传项目；GitHub 源）：
#      curl -fsSL https://raw.githubusercontent.com/<你的账号>/LCZOJ/main/bootstrap.sh | sudo bash
#    方式二（Gitee 源）：
#      curl -fsSL https://gitee.com/<你的账号>/LCZOJ/raw/main/bootstrap.sh | sudo bash
#    方式三（项目已在服务器上）：
#      cd /path/to/LCZOJ && sudo bash install-centos.sh
#    方式四（从仓库拉取到 /opt/lczoj 后执行本脚本）：
#      export LCZOJ_REPO_URL=https://github.com/你的仓库/LCZOJ
#      curl -fsSL https://raw.githubusercontent.com/你的仓库/LCZOJ/main/install-centos.sh | sudo bash
#
#  脚本自动完成：
#    1) 安装 Node.js 24 LTS（NodeSource 官方源，CentOS 7 自动回退官方二进制）
#    2) 安装全部评测语言编译器（C/C++/Python/Pascal/PHP/Go/Java）
#    3) 注册为 systemd 服务（开机自启）
#    4) 开放防火墙 80 端口（firewalld）
#    5) 启动网站，可直接外网访问
# =============================================================================
set -e

echo "=============================================="
echo "  LCZOJ 一键部署（CentOS / RHEL）"
echo "=============================================="

# ---------------- 0. 定位项目目录（支持从仓库拉取） ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
else
  PROJECT_DIR="/opt/lczoj"
  if [ ! -f "$PROJECT_DIR/server.js" ]; then
    if [ -n "$LCZOJ_REPO_URL" ]; then
      echo "未在当前目录找到项目，正在从仓库拉取到 $PROJECT_DIR …"
      mkdir -p /opt
      command -v git >/dev/null 2>&1 || yum install -y git >/dev/null 2>&1 || dnf install -y git >/dev/null 2>&1 || true
      if [ -d "$PROJECT_DIR/.git" ]; then (cd "$PROJECT_DIR" && git pull) || true; else git clone --depth 1 "$LCZOJ_REPO_URL" "$PROJECT_DIR"; fi
    else
      echo "错误：未找到 server.js。请先进入项目目录执行本脚本，" >&2
      echo "  或设置 LCZOJ_REPO_URL 后从仓库自动拉取。" >&2
      exit 1
    fi
  fi
fi
cd "$PROJECT_DIR"
echo "项目目录: $PROJECT_DIR ✓"

# ---------------- 1. 安装 Node.js 24 ----------------
PKGMGR="yum"
command -v dnf >/dev/null 2>&1 && PKGMGR="dnf"
install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then echo "Node.js $(node -v) ✓"; return 0; fi
  fi
  echo "安装 Node.js 24 LTS（NodeSource 官方源）…"
  if [ "$PKGMGR" = "dnf" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - || true
    "$PKGMGR" install -y nodejs >/dev/null 2>&1 || true
  else
    # CentOS 7（yum）：NodeSource 仍可用；失败则回退官方二进制
    curl -fsSL https://rpm.nodesource.com/setup_16.x | bash - >/dev/null 2>&1 || true
    "$PKGMGR" install -y nodejs >/dev/null 2>&1 || true
  fi
  if command -v node >/dev/null 2>&1; then
    local major
    major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then echo "Node.js $(node -v) ✓"; return 0; fi
  fi
  # 回退：下载官方 Node.js 24 二进制
  echo "改用官方二进制安装 Node.js 24…"
  ARCH=$(uname -m)
  case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "不支持的架构" >&2; exit 1 ;; esac
  VER=v24.19.0
  curl -fsSL "https://nodejs.org/dist/${VER}/node-${VER}-linux-${ARCH}.tar.xz" -o /tmp/node.tar.xz
  tar -xf /tmp/node.tar.xz -C /opt
  ln -sf "/opt/node-${VER}-linux-${ARCH}/bin/node" /usr/local/bin/node
  ln -sf "/opt/node-${VER}-linux-${ARCH}/bin/npm" /usr/local/bin/npm
  hash -r
  echo "Node.js $(node -v) ✓"
}
command -v curl >/dev/null 2>&1 || "$PKGMGR" install -y curl >/dev/null 2>&1 || true
install_node

# ---------------- 2. 安装全部评测语言编译器 ----------------
# 每个编译器独立安装，确保 Pascal 与 Go 一定会被安装
echo "安装评测语言编译器（每个独立安装，缺失的包自动跳过）…"
# fpc 位于 EPEL 仓库（CentOS 7 亦有）
"$PKGMGR" install -y epel-release >/dev/null 2>&1 || true
# 启用 CRB / PowerTools 仓库：C/C++ 静态链接库（glibc-static / libstdc++-static）在此仓库
# RHEL 9 / CentOS 9 / Rocky 9 / Alma 9 → crb；RHEL 8 / CentOS 8 / Rocky 8 → powertools
if command -v dnf >/dev/null 2>&1; then
  dnf config-manager --set-enabled crb >/dev/null 2>&1 || true
  dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
elif command -v yum-config-manager >/dev/null 2>&1; then
  yum-config-manager --enable crb >/dev/null 2>&1 || true
  yum-config-manager --enable powertools >/dev/null 2>&1 || true
fi
"$PKGMGR" install -y gcc gcc-c++ python3 || true
# 静态库（C/C++ -static 链接需要 libstdc++.a / libc.a / libm.a / libgcc.a）
"$PKGMGR" install -y glibc-static libstdc++-static libgcc-static >/dev/null 2>&1 || true
"$PKGMGR" install -y fpc || true          # Pascal
"$PKGMGR" install -y golang || true       # Go
"$PKGMGR" install -y php-cli || true
if [ "$PKGMGR" = "dnf" ]; then
  # Java 21（CentOS/RHEL 9 提供；缺失时回退 17）
  "$PKGMGR" install -y java-21-openjdk-devel >/dev/null 2>&1 || "$PKGMGR" install -y java-17-openjdk-devel >/dev/null 2>&1 || true
  "$PKGMGR" install -y rust >/dev/null 2>&1 || true
else
  "$PKGMGR" install -y java-1.8.0-openjdk-devel >/dev/null 2>&1 || true
fi

# 静态链接自检：验证 g++ -static 可用（部署后 C/C++ 评测不再报 cannot find -lstdc++/-lm/-lc）
echo "静态链接自检（g++ -static）…"
STATIC_TEST=$(mktemp -d)
echo 'int main(){return 0;}' > "$STATIC_TEST/t.cpp"
if g++ -static "$STATIC_TEST/t.cpp" -o "$STATIC_TEST/t" >/dev/null 2>&1; then
  echo "  ✓ g++ -static 静态链接正常"
else
  echo "  ⚠ g++ -static 失败：请检查是否安装 glibc-static / libstdc++-static（需启用 crb/powertools 仓库）"
  echo "    若静态库不可用，判题引擎会自动改用动态链接（不影响评测）"
fi
rm -rf "$STATIC_TEST"

echo "语言工具链："
for t in gcc g++ python3 fpc php go rustc javac; do
  command -v "$t" >/dev/null 2>&1 && echo "  ✓ $t" || echo "  ✗ $t（未安装，可稍后手动装）"
done

# ---------------- 3. 注册 systemd 服务（开机自启） ----------------
PORT="${PORT:-80}"
cat > /etc/systemd/system/lczoj.service <<EOF
[Unit]
Description=LCZOJ Online Judge
After=network.target

[Service]
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/env node server.js
Environment=PORT=$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable lczoj.service >/dev/null 2>&1 || true
systemctl restart lczoj.service
echo "systemd 服务已注册并启动 ✓（开机自启）"

# ---------------- 4. 开放防火墙 80 端口（firewalld） ----------------
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=80/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "防火墙：已放行 80 端口（firewalld）✓"
elif command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || true
  echo "防火墙：已放行 80 端口（iptables）✓"
else
  echo "未检测到防火墙工具（若使用云安全组，请手动放行 80 端口）"
fi

# ---------------- 5. 显示访问地址 ----------------
PUBLIC_IP=""
PUBLIC_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || true)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

sleep 1
echo ""
echo "=============================================="
echo "  LCZOJ 部署完成 ✓"
if [ "$PORT" = "80" ]; then
  echo "  本机访问:   http://localhost"
  [ -n "$PUBLIC_IP" ] && echo "  外网访问:   http://$PUBLIC_IP"
else
  echo "  本机访问:   http://localhost:$PORT"
  [ -n "$PUBLIC_IP" ] && echo "  外网访问:   http://$PUBLIC_IP:$PORT"
fi
echo "  管理员账号: admin / admin123（请尽快修改密码）"
echo ""
echo "  查看状态: systemctl status lczoj"
echo "  查看日志: journalctl -u lczoj -f"
echo "  停止服务: systemctl stop lczoj"
echo "=============================================="
