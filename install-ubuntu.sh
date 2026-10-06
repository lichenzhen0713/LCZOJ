#!/usr/bin/env bash
# =============================================================================
#  LCZOJ - Ubuntu / Debian 一键部署脚本（全新系统直接可用）
#
#  用法（在全新 Ubuntu/Debian 服务器上）：
#    方式一（推荐，一条命令，无需上传项目；GitHub 源）：
#      curl -fsSL https://raw.githubusercontent.com/<你的账号>/LCZOJ/master/bootstrap.sh | sudo bash
#    方式二（Gitee 源）：
#      curl -fsSL https://gitee.com/<你的账号>/LCZOJ/raw/master/bootstrap.sh | sudo bash
#    方式三（项目已在服务器上）：
#      cd /path/to/LCZOJ && sudo bash install-ubuntu.sh
#    方式四（从仓库拉取到 /opt/lczoj 后执行本脚本）：
#      export LCZOJ_REPO_URL=https://github.com/你的仓库/LCZOJ
#      curl -fsSL https://raw.githubusercontent.com/你的仓库/LCZOJ/master/install-ubuntu.sh | sudo bash
#
#  脚本自动完成：
#    1) 安装 Node.js 24 LTS（NodeSource 官方源）
#    2) 安装全部评测语言编译器（C/C++/Python/Pascal/PHP/Go/Rust/Java）
#    3) 注册为 systemd 服务（开机自启；ExecStart 用 node 绝对路径；
#       非 root 绑 <1024 端口自动加 AmbientCapabilities=CAP_NET_BIND_SERVICE）
#    4) 开放防火墙端口（ufw），并提示云厂商安全组
#    5) 直接监听 0.0.0.0:80 对外（本脚本不安装 Nginx）；
#       只有你另有 Nginx / 面板反代时才用 OJ_HOST=127.0.0.1（此时一般 PORT=3000）
#    6) 启动后轮询健康检查：通过才打印访问地址，失败则打印 systemctl/journalctl 与排查清单
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
umask 022   # M17：日志/临时文件权限稳定（不要用 000 之类会放开的 umask）

# ---------------- 0. 下载-校验-执行助手（M18） ----------------
# 用法：fetch_and_run <url> <期望SHA256，可空> <落地路径>
# 有期望值时：不匹配就拒绝执行并退出；没有期望值时：打印显著警告 + 计算出的 SHA256（供你写进环境变量）。
fetch_and_run() {
  local url="$1" want="$2" dest="$3"
  echo "  下载 $url → $dest"
  curl -fsSL "$url" -o "$dest" || { echo "  ✗ 下载失败：$url" >&2; return 1; }
  local got
  got=$(sha256sum "$dest" | awk '{print $1}')
  if [ -n "$want" ]; then
    if [ "$got" != "$want" ]; then
      echo "  ✗ SHA256 校验失败！期望 $want，实际 $got" >&2
      echo "    已拒绝执行 $dest（可能是上游更新或中间人篡改，请人工确认）" >&2
      rm -f "$dest"; return 1
    fi
    echo "  ✓ SHA256 校验通过（$got）"
  else
    echo "  ⚠ 未提供期望 SHA256，无法校验来源完整性！"
    echo "    实际 SHA256 = $got"
    echo "    建议：确认无误后把该值通过环境变量固定下来再重跑，例如"
    echo "      LCZOJ_NODESOURCE_SHA256=$got sudo bash install-ubuntu.sh"
  fi
  case "$dest" in
    *.sh) bash "$dest" ;;
    *) bash "$dest" ;;
  esac
}

# ---------------- 1. 安装 Node.js 24（NodeSource 官方源，含自动升级） ----------------
install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then echo "Node.js $(node -v) ✓"; return 0; fi
  fi
  echo "安装 Node.js 24 LTS（NodeSource 官方源）…"
  # M18：先下载到本地 → 校验 SHA256（可用 LCZOJ_NODESOURCE_SHA256 提供期望值）→ 再执行，
  # 不再 `curl | bash`（管道执行时无法校验内容，一旦上游被篡改就直接以 root 执行）。
  fetch_and_run https://deb.nodesource.com/setup_24.x "${LCZOJ_NODESOURCE_SHA256:-}" /tmp/lczoj-nodesource.sh
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

# ---------------- 3. 专用低权账户 + 数据目录最小权限（H1 / M16） ----------------
# 服务以 lczoj 账户运行；判题时再把选手程序降到 nobody（H1，见 OJ_JUDGE_USER）。
if ! id -u lczoj >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin lczoj 2>/dev/null || adduser --system --no-create-home lczoj || true
  echo "  ✓ 已创建低权账户 lczoj"
fi
# data/：700 属 lczoj（数据库/测试数据/评测产物都在里面，选手程序读不到）
mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/logs"
chown -R lczoj:lczoj "$PROJECT_DIR" 2>/dev/null || true
chmod 700 "$PROJECT_DIR/data" "$PROJECT_DIR/logs" 2>/dev/null || true
# 数据库文件：600（只有服务账户可读写）
chmod 600 "$PROJECT_DIR"/data/oj.db* 2>/dev/null || true
# 初始管理员密码文件：600（登录后请删除，见 docs/FAQ.md）
chmod 600 "$PROJECT_DIR"/data/admin-password.txt 2>/dev/null || true
# 日志目录 700 / 日志文件 600（M17：避免日志被同机其他用户读取）
find "$PROJECT_DIR/logs" -type f -exec chmod 600 {} + 2>/dev/null || true
echo "  ✓ data/ 0700、oj.db* 0600、logs 0700/0600，属主 lczoj"

# ---------------- 4. 解析 Node 绝对路径（systemd 的 PATH 很窄，不能用 /usr/bin/env node） ----------------
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || { echo "错误：找不到 node 可执行文件，无法注册 systemd 服务。" >&2; exit 1; }
echo "Node 可执行文件: $NODE_BIN ✓"
case "$NODE_BIN" in
  /home/*|/root/*|/run/user/*)
    echo "⚠ 警告：node 位于用户主目录（$NODE_BIN）。systemd 以 lczoj 运行时看不到该路径（ProtectHome），"
    echo "  服务会起不来。请改用系统级 Node（apt install nodejs 或 NodeSource 源）后重跑本脚本。"
    ;;
esac

# ---------------- 5. 注册 systemd 服务（开机自启 + L16 加固） ----------------
PORT="${PORT:-80}"
# 监听地址：本脚本是「直连」路线（不安装 Nginx），必须监听 0.0.0.0 外网才访问得到。
# 只有明确用 Nginx / 宝塔等面板反代时才用 OJ_HOST=127.0.0.1（那时通常 PORT=3000）。
BIND_HOST="${OJ_HOST:-0.0.0.0}"
case "$BIND_HOST" in
  127.0.0.1|localhost|::1)
    if command -v nginx >/dev/null 2>&1; then
      echo "[提示] 检测到 Nginx：按 OJ_HOST=$BIND_HOST 只监听本机，请确认反代已指向 127.0.0.1:$PORT"
    else
      echo "[警告] OJ_HOST=$BIND_HOST 只监听本机，但系统里没有 Nginx/反向代理 → 外网必然访问不到。"
      echo "       已自动改为 0.0.0.0 直连。确实要只监听本机的话，请先配好 Nginx 反代（deploy/nginx-lczoj.conf）再执行："
      echo "       OJ_HOST=127.0.0.1 PORT=3000 sudo bash install-ubuntu.sh"
      BIND_HOST=0.0.0.0
    fi
    ;;
esac

# 非 root 绑定 <1024 端口需要 CAP_NET_BIND_SERVICE：
# Ubuntu ≤ 22.04 的 net.ipv4.ip_unprivileged_port_start 默认是 1024，lczoj 账户绑 80 会 EACCES（服务起不来）。
PORT_CAPS=""
if [ "$PORT" -lt 1024 ] 2>/dev/null; then
  PORT_CAPS="# 非 root 绑定 $PORT 端口所需能力（与 NoNewPrivileges 兼容：systemd 在 execve 前提升环境能力，NNP 只拦 setuid/文件能力）
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
fi

# ProtectHome=true 会让服务看不到 /home、/root、/run/user；项目放在这些目录下时服务读不到 server.js。
PROTECT_HOME="true"
case "$PROJECT_DIR" in
  /home/*|/root|/root/*|/run/user/*)
    PROTECT_HOME="false"
    echo "[提示] 项目目录位于用户主目录（$PROJECT_DIR），已关闭 ProtectHome（否则服务读不到 server.js）。"
    echo "       建议把项目移到 /opt/lczoj，隔离更彻底。"
    ;;
esac

cat > /etc/systemd/system/lczoj.service <<EOF
[Unit]
Description=LCZOJ Online Judge
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
# 绝对路径：systemd 的 PATH 很窄，用 /usr/bin/env node 在 Node 装到 /usr/local/bin（NodeSource）或 nvm 下会找不到
ExecStart=$NODE_BIN server.js
User=lczoj
Group=lczoj
Environment=PORT=$PORT
# 直连对外监听；用 Nginx/面板反代时才改成 127.0.0.1（同时把 PORT 改成 3000）
Environment=OJ_HOST=$BIND_HOST
Environment=OJ_JUDGE_USER=nobody
Environment=TZ=Asia/Shanghai
# 判题要调用 g++ / python3 / javac 等，显式给出完整 PATH
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
$PORT_CAPS

# ---------------- 加固（L16） ----------------
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=$PROTECT_HOME
ProtectSystem=strict
# 注意：项目代码目录在 ProtectSystem=strict 下是**只读**的。后台「一键更新」要覆盖项目文件，
# 在这个单元里会失败（EROFS）；请改用：sudo node deploy/update.js，或重跑本安装脚本。
ReadWritePaths=$PROJECT_DIR/data $PROJECT_DIR/logs /tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable lczoj.service >/dev/null 2>&1 || true
# 启动失败不要在这里直接退出（set -e 会让用户看不到任何报错），交给下面的健康检查统一诊断
systemctl restart lczoj.service || true

# ---------------- 6. 开放防火墙端口（ufw） ----------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw allow "$PORT" >/dev/null 2>&1 || true
  echo "防火墙：已放行 $PORT 端口（ufw）✓（云厂商【安全组】也要放行，否则外网仍然打不开）"
else
  echo "未检测到 ufw（若使用云安全组，请手动放行 $PORT 端口）"
fi

# ---------------- 7. 健康检查：确认服务真的起来、真的能访问 ----------------
health_up() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"up"'
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O - "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"up"'
  else
    return 1
  fi
}

wait_health() {
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_up; then return 0; fi
    sleep 1
  done
  return 1
}

# 启动失败时的诊断：systemd 状态 + 日志尾部 + 端口占用 + 排查清单
show_failure_diagnostics() {
  echo "------------------------------------------------------------"
  echo "systemctl status lczoj --no-pager -l"
  systemctl status lczoj --no-pager -l 2>&1 | tail -n 20 || true
  echo "------------------------------------------------------------"
  echo "journalctl -u lczoj -n 40 --no-pager"
  journalctl -u lczoj -n 40 --no-pager 2>&1 | tail -n 40 || true
  echo "------------------------------------------------------------"
  echo "端口 $PORT 监听情况："
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || echo "  （没有进程在监听 $PORT）"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || echo "  （没有进程在监听 $PORT）"
  fi
  echo "------------------------------------------------------------"
  echo "按这个清单排查："
  echo "  1) 云安全组：控制台放行 $PORT/tcp（ufw 放行 ≠ 安全组放行，这是最常见原因）"
  echo "  2) 端口被占：ss -ltnp | grep ':$PORT '（Apache / Nginx / 上一个 LCZOJ 实例）"
  echo "  3) 监听地址：单元里是 OJ_HOST=$BIND_HOST（127.0.0.1 只能本机访问）"
  echo "  4) Node 路径：单元里是 ExecStart=$NODE_BIN，确认存在且可执行：ls -l $NODE_BIN"
  echo "  5) 目录权限：ls -ld data logs 必须属 lczoj（sudo chown -R lczoj:lczoj data logs）"
  echo "  6) 手动前台复现：sudo -u lczoj env PORT=$PORT OJ_HOST=$BIND_HOST $NODE_BIN server.js"
  echo "  7) 服务账户能否读到代码：sudo -u lczoj test -r $PROJECT_DIR/server.js && echo OK"
  echo "     （读不到 → 服务必然起不来；/root 权限是 0700，项目放 /root 下一定失败，请移到 /opt/lczoj）"
  echo "  8) 想换端口：PORT=8080 sudo bash install-ubuntu.sh"
  echo "把以上整段内容复制给管理员可快速定位。"
}

HEALTH_NOTE="（健康检查通过）"
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "[提示] 未找到 curl / wget，无法自动做健康检查（请稍后自行访问验证）"
  HEALTH_OK=1
  HEALTH_NOTE="（未找到 curl/wget，已跳过健康检查）"
elif wait_health; then
  HEALTH_OK=1
else
  HEALTH_OK=0
fi

if [ "$HEALTH_OK" != "1" ]; then
  echo ""
  echo "=============================================="
  echo "  ✗ LCZOJ 启动失败：健康检查 http://127.0.0.1:$PORT/api/health 30 秒内没有返回 up"
  echo "=============================================="
  show_failure_diagnostics
  exit 1
fi

echo "systemd 服务已注册并启动 ✓（开机自启，以 lczoj 账户运行）$HEALTH_NOTE"

# ---------------- 8. 输出访问地址 ----------------
PUBLIC_IP=""
PUBLIC_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || true)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

# 读取首次启动随机生成的初始管理员密码，直接显示在「部署完成」页面
ADMIN_PWD=""
for i in $(seq 1 20); do
  if [ -s data/admin-password.txt ]; then
    ADMIN_PWD="$(sed -n 's/^admin-password: //p' data/admin-password.txt | head -n1)"
    [ -n "$ADMIN_PWD" ] || ADMIN_PWD="$(sed -n 's/^初始密码：//p' data/admin-password.txt | head -n1)"
    [ -n "$ADMIN_PWD" ] && break
  fi
  sleep 1
done

echo ""
echo "=============================================="
echo "  LCZOJ 部署完成 ✓$HEALTH_NOTE"
echo "  服务状态:   $(systemctl is-active lczoj 2>/dev/null || echo unknown)　监听: $BIND_HOST:$PORT"
if [ "$BIND_HOST" = "127.0.0.1" ]; then
  echo "  ⚠ 只监听本机：必须由 Nginx/面板反代后才能从外网访问（见 deploy/nginx-lczoj.conf）"
fi
if [ "$PORT" = "80" ]; then
  echo "  本机访问:   http://localhost"
  [ -n "$PUBLIC_IP" ] && echo "  外网访问:   http://$PUBLIC_IP   （打不开先查云厂商安全组是否放行 80）"
else
  echo "  本机访问:   http://localhost:$PORT"
  [ -n "$PUBLIC_IP" ] && echo "  外网访问:   http://$PUBLIC_IP:$PORT   （打不开先查云厂商安全组是否放行 $PORT）"
fi
echo "  管理员账号: admin"
if [ -n "$ADMIN_PWD" ]; then
  echo "  初始密码:   $ADMIN_PWD"
  echo "              （首次启动随机生成，登录后请立刻修改密码）"
else
  echo "  初始密码:   随机生成，见 data/admin-password.txt"
  echo "              （或执行 journalctl -u lczoj | grep -m1 初始密码 查看）"
fi
echo ""
echo "  查看状态: systemctl status lczoj"
echo "  查看日志: journalctl -u lczoj -f"
echo "  停止服务: systemctl stop lczoj"
echo "=============================================="
