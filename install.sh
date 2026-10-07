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
#  脚本还会：检测端口占用（80 被占用时自动显示占用进程并改用 8080/8081/8082）、
#            轮询健康检查等待服务就绪、并在「部署完成」时醒目显示管理员初始密码。
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

# ---------------- 5. 选择可用端口（被占用时自动改用 8080/8081/8082） ----------------
LOG_FILE="logs/lczoj.log"

# 端口是否正在被监听（优先 ss，其次 netstat）
port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | grep -qE "[:.]${p}\$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{ print $4 }' | grep -qE "[:.]${p}\$"
  else
    return 1
  fi
}

# 打印占用端口的进程（需要 root 才能看到进程名；看不到时给出查看命令）
port_owner() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E "[:.]${p}[[:space:]]" | head -n1 | sed 's/^[[:space:]]*//'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | grep -E "[:.]${p}[[:space:]]" | head -n1 | sed 's/^[[:space:]]*//'
  fi
  return 0
}

# 健康检查：/api/health 返回 200 且内容包含 status: up
health_up() {
  local p="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "http://127.0.0.1:${p}/api/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"up"'
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O - "http://127.0.0.1:${p}/api/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"up"'
  else
    return 1
  fi
}

wait_health() {
  local p="$1" deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_up "$p"; then return 0; fi
    sleep 1
  done
  return 1
}

# 启动失败时打印日志尾部与端口检查结果，方便用户直接复制给管理员
show_log_tail() {
  echo "------------------------------------------------------------"
  if [ -s "$LOG_FILE" ]; then
    echo "服务日志尾部（$LOG_FILE，最后 20 行）："
    tail -n 20 "$LOG_FILE"
  else
    echo "（日志文件 $LOG_FILE 不存在或为空：服务可能没有成功启动）"
  fi
  echo "------------------------------------------------------------"
  echo "端口监听检查（端口 $PORT）："
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || echo "  （没有进程在监听该端口）"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || echo "  （没有进程在监听该端口）"
  else
    echo "  （未找到 ss / netstat，跳过端口检查）"
  fi
  echo "------------------------------------------------------------"
  echo "请把以上整段内容复制给管理员，便于定位问题。"
}

# 醒目显示管理员初始密码（首次初始化由 src/db.js 的 seed() 随机生成，
# 明文写入 数据目录/admin-password.txt；用户首次登录改密后该文件会被自动删除）
show_admin_pwd() {
  local f="data/admin-password.txt" pwd="" i=0
  if [ -n "${OJ_DATA_DIR:-}" ]; then f="${OJ_DATA_DIR}/admin-password.txt"; fi
  while [ "$i" -lt 10 ]; do
    if [ -s "$f" ]; then
      pwd="$(sed -n 's/^admin-password: //p' "$f" | head -n1)"
      if [ -z "$pwd" ]; then pwd="$(sed -n 's/^初始密码：//p' "$f" | head -n1)"; fi
      if [ -n "$pwd" ]; then break; fi
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "  **************** 请立即记录以下登录信息 ****************"
  echo "    管理员账号:  admin"
  if [ -n "$pwd" ]; then
    echo "    初始密码:    $pwd"
    echo "  ********************************************************"
    echo "    首次登录后会强制要求修改密码；"
    echo "    初始密码文件：$f，改密后会自动删除；"
    echo "    忘记密码：运行 reset.sh 重置数据后会重新生成初始密码。"
  else
    echo "    初始密码:    未找到初始密码文件 $f"
    echo "  ********************************************************"
    echo "    （通常表示你已改过密码，直接用你的密码登录；改密后该文件会自动删除）"
    echo "    忘记密码可运行 reset.sh 重置数据后重新生成。"
  fi
}

PORT_WANT="$PORT"
REUSE_RUNNING=0

if [ "$START" = "0" ]; then
  echo ""
  echo "依赖安装完成（未启动）。使用以下命令启动："
  echo "  PORT=$PORT node server.js"
  exit 0
fi

if [ ! -f server.js ]; then
  echo "错误：当前目录下找不到 server.js，请确认 install.sh 与 server.js 在同一目录。" >&2
  exit 1
fi

if port_in_use "$PORT_WANT"; then
  echo ""
  echo "[警告] 端口 $PORT_WANT 已被占用："
  PORT_OWNER="$(port_owner "$PORT_WANT" || true)"
  if [ -n "$PORT_OWNER" ]; then echo "        $PORT_OWNER"; fi
  echo "        查看占用进程：ss -ltnp | grep ':$PORT_WANT '（或 netstat -ltnp | grep ':$PORT_WANT '）"
  if health_up "$PORT_WANT"; then
    echo "[提示] 该端口上已经有 LCZOJ 服务在运行（健康检查通过），直接复用它，不再重复启动。"
    REUSE_RUNNING=1
  else
    echo "        该端口上的程序不是 LCZOJ（或尚未就绪），将自动改用备用端口启动。"
    for alt in 8080 8081 8082; do
      if ! port_in_use "$alt"; then PORT="$alt"; break; fi
    done
    if [ "$PORT" = "$PORT_WANT" ]; then
      echo ""
      echo "[错误] 备用端口 8080 / 8081 / 8082 全部被占用，无法自动启动服务。"
      echo "        请先释放其中一个端口，或用 --port 9000 指定其它端口后重新运行本脚本。"
      echo "------------------------------------------------------------"
      exit 1
    fi
    echo "[提示] $PORT_WANT 被占用，已改用 $PORT 端口。"
    echo "        若想恢复使用 $PORT_WANT：先结束占用它的进程再重新运行本脚本。"
  fi
fi

mkdir -p logs
NODE_PID=""
READY=1
if [ "$REUSE_RUNNING" = "1" ]; then
  echo ""
  echo "检测到该端口已有 LCZOJ 服务，未重复启动新实例。"
else
  echo ""
  echo "启动 LCZOJ 服务（端口 $PORT）..."
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') 启动 LCZOJ（端口 $PORT） =====" >> "$LOG_FILE"
  if [ "$DAEMON" = "1" ]; then
    nohup env PORT="$PORT" node server.js >> "$LOG_FILE" 2>&1 &
  else
    PORT="$PORT" node server.js >> "$LOG_FILE" 2>&1 &
  fi
  NODE_PID=$!
  if [ "$DAEMON" != "1" ]; then
    trap 'kill "$NODE_PID" 2>/dev/null' INT TERM
  fi
  echo "正在等待服务就绪（最多约 30 秒）..."
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "[提示] 未找到 curl / wget，跳过健康检查；稍后请直接访问下面的地址。"
    sleep 3
  elif ! wait_health "$PORT"; then
    READY=0
  fi
fi

if [ "$READY" != "1" ]; then
  echo ""
  echo "[错误] 服务在约 30 秒内仍未就绪（健康检查 http://127.0.0.1:$PORT/api/health 没有返回 up）。"
  show_log_tail
  echo "也可以手动前台运行查看完整报错：PORT=$PORT node server.js"
  exit 1
fi

echo ""
echo "=============================================="
echo "  LCZOJ 部署完成"
echo "=============================================="
echo "  访问地址:   http://localhost:$PORT"
if [ "$PORT" != "$PORT_WANT" ]; then echo "               （$PORT_WANT 端口被占用，本次改用 $PORT 端口）"; fi
if [ "$REUSE_RUNNING" = "1" ]; then echo "               （该端口已有 LCZOJ 服务在运行，未重复启动新实例）"; fi
show_admin_pwd
echo "  服务日志:   $LOG_FILE"
if [ "$REUSE_RUNNING" = "1" ]; then
  echo "  停止服务:   本脚本不停止已有实例（如需停止：pkill -f 'node server.js'）"
elif [ "$DAEMON" = "1" ]; then
  echo "  实时日志:   tail -f $LOG_FILE"
  echo "  停止服务:   kill $NODE_PID"
else
  echo "  实时日志:   tail -f $LOG_FILE"
  echo "  停止服务:   Ctrl+C（或 kill $NODE_PID）"
fi
echo "=============================================="

if [ "$REUSE_RUNNING" != "1" ] && [ "$DAEMON" != "1" ]; then
  echo "服务正在前台运行：按 Ctrl+C 停止（日志同时写入 $LOG_FILE）。"
  wait "$NODE_PID" || true
  echo "服务已停止。"
fi
