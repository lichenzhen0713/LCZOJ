#!/usr/bin/env bash
# =============================================================================
#  LCZOJ - Ubuntu / Debian 一键部署脚本（全新系统直接可用）
#
#  用法（在全新 Ubuntu/Debian 服务器上）：
#    方式一（推荐，一条命令，无需上传项目；GitHub 源）：
#      curl -fsSL https://raw.githubusercontent.com/<你的账号>/LCZOJ/main/bootstrap.sh | sudo bash
#    方式二（Gitee 源）：
#      curl -fsSL https://gitee.com/<你的账号>/LCZOJ/raw/main/bootstrap.sh | sudo bash
#    方式三（项目已在服务器上）：
#      cd /path/to/LCZOJ && sudo bash install-ubuntu.sh
#    方式四（从仓库拉取到 /opt/lczoj 后执行本脚本）：
#      export LCZOJ_REPO_URL=https://github.com/你的仓库/LCZOJ
#      curl -fsSL https://raw.githubusercontent.com/你的仓库/LCZOJ/main/install-ubuntu.sh | sudo bash
#
#  脚本自动完成：
#    1) 安装 Node.js 24 LTS（NodeSource 官方源）
#    2) 安装全部评测语言编译器（C/C++/Python/Pascal/PHP/Go/Rust/Java）
#    3) 注册为 systemd 服务（开机自启）
#    4) 开放防火墙 80 端口（ufw）
#    5) 启动网站，可直接外网访问
# =============================================================================
set -e

echo "=============================================="
echo "  LCZOJ 一键部署（Ubuntu / Debian）"
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
      command -v git >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y git >/dev/null 2>&1 || true; }
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

# ---------------- 1. 安装 Node.js 24（NodeSource 官方源，含自动升级） ----------------
install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then echo "Node.js $(node -v) ✓"; return 0; fi
  fi
  echo "安装 Node.js 24 LTS（NodeSource 官方源）…"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  echo "Node.js $(node -v) ✓"
}
if ! command -v curl >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl >/dev/null 2>&1 || true
fi
install_node

# ---------------- 2. 安装全部评测语言编译器 ----------------
# 每个编译器独立安装，确保 Pascal 与 Go 一定会被安装
echo "安装评测语言编译器（每个独立安装，缺失的包自动跳过）…"
DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
DEBIAN_FRONTEND=noninteractive apt-get install -y gcc g++ python3 || true
# 静态库（C/C++ -static 链接需要 libstdc++.a / libc.a / libm.a，由 -dev 包提供）
DEBIAN_FRONTEND=noninteractive apt-get install -y libstdc++-dev libc6-dev libgcc-14-dev >/dev/null 2>&1 || \
DEBIAN_FRONTEND=noninteractive apt-get install -y libstdc++-dev libc6-dev >/dev/null 2>&1 || true
DEBIAN_FRONTEND=noninteractive apt-get install -y fp-compiler || true   # Pascal
DEBIAN_FRONTEND=noninteractive apt-get install -y golang-go || true     # Go
DEBIAN_FRONTEND=noninteractive apt-get install -y php-cli || true
DEBIAN_FRONTEND=noninteractive apt-get install -y rustc cargo || true
# Java 21（Ubuntu 22.04+ 提供 openjdk-21-jdk-headless；缺失时回退 default-jdk-headless）
DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-21-jdk-headless >/dev/null 2>&1 || \
DEBIAN_FRONTEND=noninteractive apt-get install -y default-jdk-headless || true

# 静态链接自检：验证 g++ -static 可用（部署后 C/C++ 评测不再报 cannot find -lstdc++/-lm/-lc）
echo "静态链接自检（g++ -static）…"
STATIC_TEST=$(mktemp -d)
echo 'int main(){return 0;}' > "$STATIC_TEST/t.cpp"
if g++ -static "$STATIC_TEST/t.cpp" -o "$STATIC_TEST/t" >/dev/null 2>&1; then
  echo "  ✓ g++ -static 静态链接正常"
else
  echo "  ⚠ g++ -static 失败：请检查是否安装 libstdc++-dev / libc6-dev"
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

# ---------------- 4. 开放防火墙 80 端口（ufw） ----------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 80 >/dev/null 2>&1 || true
  echo "防火墙：已放行 80 端口（ufw）✓"
else
  echo "未检测到 ufw（若使用云安全组，请手动放行 80 端口）"
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
echo "  管理员账号: admin（初始密码随机生成，见 data/admin-password.txt 或上面的启动日志）"
echo ""
echo "  查看状态: systemctl status lczoj"
echo "  查看日志: journalctl -u lczoj -f"
echo "  停止服务: systemctl stop lczoj"
echo "=============================================="
