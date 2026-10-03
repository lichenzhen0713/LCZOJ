#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 在线评测系统 - Linux 一键部署脚本（小白友好版）
#  只需执行一次，脚本会自动完成：
#    1) 安装 / 升级 Node.js（≥ 22.5，自动处理，无需手动装）
#    2) 安装全部评测语言编译器（C/C++、Python、Pascal、PHP、Go、Rust、Java）
#    3) 启动网站
#
#  支持发行版：Debian/Ubuntu、Fedora/RHEL/CentOS、Arch/Manjaro、Alpine、openSUSE
#
#  用法：
#    chmod +x install.sh
#    ./install.sh               # 一键安装并启动（前台运行）
#    ./install.sh --port 8080   # 指定端口
#    ./install.sh --daemon      # 安装后在后台运行（适合新手，关掉终端也不停）
#    ./install.sh --no-start    # 只安装依赖，不启动
# =============================================================================
set -e

PORT="${PORT:-80}"
START=1
DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --daemon) DAEMON=1 ;;
    --port=*) PORT="${arg#--port=}" ;;
  esac
done
# 兼容 `--port 8080` 的旧写法
if [ "$1" = "--port" ] && [ -n "$2" ]; then PORT="$2"; fi

echo "=============================================="
echo "  LCZOJ 在线评测系统 - 一键部署"
echo "=============================================="

# ---------------- 1. 检测发行版与包管理器 ----------------
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
elif command -v pacman >/dev/null 2>&1; then PKG=pacman
elif command -v apk >/dev/null 2>&1; then PKG=apk
elif command -v zypper >/dev/null 2>&1; then PKG=zypper
else
  echo "错误：无法识别的包管理器，请手动安装 Node.js ≥ 22.5（https://nodejs.org/zh-cn/download）" >&2
  exit 1
fi
echo "检测到包管理器: $PKG"

# ---------------- 2. 确保 Node.js ≥ 22.5 ----------------
# 已有且版本足够 → 直接用；否则先用包管理器装，仍不行则下载官方二进制（全自动）
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
  if [ "${NODE_MAJOR:-0}" -ge 22 ]; then NODE_OK=1; fi
fi

if [ "$NODE_OK" = "1" ]; then
  echo "Node.js 版本: $(node -v) ✓（无需安装）"
else
  echo "未检测到可用的 Node.js（需要 ≥ 22.5），正在自动安装…"
  # 2a. 先尝试用包管理器安装
  case "$PKG" in
    apt)  apt-get update -y >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm >/dev/null 2>&1 || true ;;
    dnf)  dnf install -y nodejs npm >/dev/null 2>&1 || true ;;
    yum)  yum install -y nodejs npm >/dev/null 2>&1 || true ;;
    pacman) pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || true ;;
    apk)  apk add --no-cache nodejs npm >/dev/null 2>&1 || true ;;
    zypper) zypper --non-interactive install nodejs npm >/dev/null 2>&1 || true ;;
  esac
  # 2b. 验证版本；仍不满足（缺失或过旧）则下载官方 Node.js 二进制
  NODE_OK=0
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "${NODE_MAJOR:-0}" -ge 22 ]; then NODE_OK=1; fi
  fi
  if [ "$NODE_OK" != "1" ]; then
    echo "包管理器提供的 Node.js 版本过低或不可用，正在下载官方 Node.js 24 LTS…"
    NODE_VER=v24.19.0
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64|amd64) ARCH=x64 ;;
      aarch64|arm64) ARCH=arm64 ;;
      *) echo "不支持的 CPU 架构: $ARCH，请手动安装 Node.js ≥ 22.5" >&2; exit 1 ;;
    esac
    TARBALL="node-${NODE_VER}-linux-${ARCH}.tar.xz"
    DEST="/opt/${TARBALL%.tar.xz}"
    if [ ! -x "$DEST/bin/node" ]; then
      curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" -o "/tmp/${TARBALL}" || { echo "下载失败，请检查网络或手动安装 Node.js ≥ 22.5（https://nodejs.org/zh-cn/download）" >&2; exit 1; }
      mkdir -p /opt
      tar -xf "/tmp/${TARBALL}" -C /opt
    fi
    ln -sf "${DEST}/bin/node" /usr/local/bin/node
    ln -sf "${DEST}/bin/npm" /usr/local/bin/npm
    hash -r
  fi
fi

# 最终校验
if ! command -v node >/dev/null 2>&1; then
  echo "错误：Node.js 安装失败，请手动安装 ≥ 22.5：https://nodejs.org/zh-cn/download" >&2
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "错误：Node.js 版本过低（$(node -v)），需要 ≥ 22.5。" >&2
  echo "可手动安装 24 LTS：curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs（Debian/Ubuntu）" >&2
  exit 1
fi
echo "Node.js 版本: $(node -v) ✓"

# ---------------- 3. 安装全部评测语言编译器 ----------------
# 每个编译器独立安装（单个包失败不影响其它语言），确保 Pascal 与 Go 一定会被安装
echo ""
echo "安装评测语言编译器（每个独立安装，缺失的包自动跳过，不影响其它语言）…"
install_pkgs() {
  case "$PKG" in
    apt)
      apt-get update -y >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y curl python3 gcc g++ || true
      # 静态库（C/C++ -static 链接需要 libstdc++.a / libc.a / libm.a）
      DEBIAN_FRONTEND=noninteractive apt-get install -y libstdc++-dev libc6-dev >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y fp-compiler || true        # Pascal
      DEBIAN_FRONTEND=noninteractive apt-get install -y golang-go || true          # Go
      DEBIAN_FRONTEND=noninteractive apt-get install -y php-cli || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y rustc cargo || true
      # Java 21（22.04+ 提供；缺失时回退 default-jdk）
      DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-21-jdk-headless >/dev/null 2>&1 || \
      DEBIAN_FRONTEND=noninteractive apt-get install -y default-jdk-headless || true
      ;;
    dnf)
      dnf install -y epel-release >/dev/null 2>&1 || true   # fpc 在 EPEL 中
      # 启用 CRB / PowerTools 仓库：静态链接库（glibc-static / libstdc++-static）在此仓库
      dnf config-manager --set-enabled crb >/dev/null 2>&1 || true
      dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
      dnf install -y curl python3 gcc gcc-c++ || true
      # 静态库（C/C++ -static 链接）
      dnf install -y glibc-static libstdc++-static libgcc-static >/dev/null 2>&1 || true
      dnf install -y fpc || true                            # Pascal
      dnf install -y golang || true                         # Go
      dnf install -y php-cli || true
      dnf install -y rust || true
      dnf install -y java-21-openjdk-devel >/dev/null 2>&1 || dnf install -y java-17-openjdk-devel || true
      ;;
    yum)
      yum install -y epel-release >/dev/null 2>&1 || true   # fpc 在 EPEL 中
      yum install -y curl python3 gcc gcc-c++ || true
      # 静态库（C/C++ -static 链接）
      yum install -y glibc-static libstdc++-static >/dev/null 2>&1 || true
      yum install -y fpc || true                            # Pascal
      yum install -y golang || true                         # Go
      yum install -y php-cli || true
      yum install -y java-1.8.0-openjdk-devel || true
      ;;
    pacman)
      pacman -Sy --noconfirm python gcc || true
      pacman -S --noconfirm fpc || true                     # Pascal
      pacman -S --noconfirm go || true                      # Go
      pacman -S --noconfirm php || true
      pacman -S --noconfirm rust || true
      pacman -S --noconfirm java-openjdk || true
      ;;
    apk)
      apk add --no-cache python3 gcc g++ || true
      # 静态库（Alpine 的 musl 静态库在 musl-dev；g++ 自带 libstdc++.a）
      apk add --no-cache musl-dev >/dev/null 2>&1 || true
      apk add --no-cache fpc || true                        # Pascal
      apk add --no-cache go || true                         # Go
      apk add --no-cache php-cli || true
      apk add --no-cache rust cargo || true
      apk add --no-cache openjdk21-jdk || true
      ;;
    zypper)
      zypper --non-interactive install python3 gcc gcc-c++ || true
      # 静态库（C/C++ -static 链接）
      zypper --non-interactive install glibc-devel-static libstdc++-devel >/dev/null 2>&1 || true
      zypper --non-interactive install fpc || true          # Pascal
      zypper --non-interactive install go || true           # Go
      zypper --non-interactive install php-cli || true
      zypper --non-interactive install rust || true
      zypper --non-interactive install java-21-openjdk-devel >/dev/null 2>&1 || zypper --non-interactive install java-17-openjdk-devel || true
      ;;
  esac
}
install_pkgs

# 静态链接自检：验证 g++ -static 可用（部署后 C/C++ 评测不再报 cannot find -lstdc++/-lm/-lc）
echo "静态链接自检（g++ -static）…"
if command -v g++ >/dev/null 2>&1; then
  STATIC_TEST=$(mktemp -d)
  echo 'int main(){return 0;}' > "$STATIC_TEST/t.cpp"
  if g++ -static "$STATIC_TEST/t.cpp" -o "$STATIC_TEST/t" >/dev/null 2>&1; then
    echo "  ✓ g++ -static 静态链接正常"
  else
    echo "  ⚠ g++ -static 失败：请检查静态库是否安装（Debian/Ubuntu: libstdc++-dev libc6-dev；CentOS/RHEL: glibc-static libstdc++-static，需启用 crb/powertools）"
    echo "    若静态库不可用，判题引擎会自动改用动态链接（不影响评测）"
  fi
  rm -rf "$STATIC_TEST"
fi

# ---------------- 4. 展示语言工具链 ----------------
echo ""
echo "语言工具链检测："
for t in gcc g++ python3 fpc php go rustc javac; do
  if command -v "$t" >/dev/null 2>&1; then
    echo "  ✓ $t: $($t --version 2>/dev/null | head -n1)"
  else
    echo "  ✗ $t: 未安装（该语言在评测中不可用，可稍后手动安装）"
  fi
done

# ---------------- 5. 启动 ----------------
if [ "$START" = "0" ]; then
  echo ""
  echo "依赖安装完成（未启动）。使用以下命令启动："
  echo "  PORT=$PORT node server.js"
  exit 0
fi

echo ""
echo "启动 LCZOJ 服务（端口 $PORT）..."
if [ "$DAEMON" = "1" ]; then
  # 后台运行：关掉终端也不停
  mkdir -p logs
  nohup env PORT="$PORT" node server.js >> logs/lczoj.log 2>&1 &
  echo "  LCZOJ 已在后台运行 ✓"
  echo "  访问地址: http://localhost:$PORT"
  echo "  实时日志: tail -f logs/lczoj.log"
  echo "  停止服务: pkill -f 'node server.js'"
else
  echo "  访问地址: http://localhost:$PORT"
  echo "  管理员账号: admin（首次启动随机生成初始密码，见 data/admin-password.txt 或启动日志）"
  echo "  按 Ctrl+C 停止"
  echo "=============================================="
  PORT="$PORT" node server.js
fi
