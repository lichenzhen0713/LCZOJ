#!/usr/bin/env bash
# =============================================================================
#  LCZOJ Docker 版一行部署（全新 Linux 服务器专用）
#
#  一条命令搞定（自动化程度最高，服务器上什么都不用预先安装）：
#
#    GitHub 源：
#      curl -fsSL https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/docker-bootstrap.sh | sudo bash
#    Gitee 源（国内网络环境更快）：
#      curl -fsSL https://gitee.com/lichenzhen0713/LCZOJ/raw/master/docker-bootstrap.sh | sudo bash
#
#  它会自动：
#    1) 安装基础工具（curl / tar / unzip / git）
#    2) **没有 Docker 就自动装好 Docker**（官方脚本 get.docker.com）并设为开机自启
#    3) 下载 LCZOJ 源码到 /opt/lczoj（GitHub 优先，Gitee 自动回退）
#    4) 构建镜像（镜像里已含全部评测语言，服务器无需再装编译器）
#    5) 启动容器（数据存 Docker 数据卷 lczoj-data，删容器不丢数据）
#    6) 等它真正就绪并打印访问地址
#
#  可用环境变量覆盖：
#    LCZOJ_DIR=/opt/lczoj              安装目录
#    LCZOJ_PORT=8080                   对外端口（默认 80，被占用时自动改用 8080）
#    LCZOJ_JUDGES=4                    并行判题数
#    LCZOJ_REPO=https://github.com/…   仓库地址（默认为官方仓库）
#    LCZOJ_GITEE=https://gitee.com/…   Gitee 备用仓库
#  示例：sudo LCZOJ_PORT=8080 bash -c "$(curl -fsSL <脚本地址>)"
# =============================================================================
set -e

: "${LCZOJ_REPO:=https://github.com/lichenzhen0713/LCZOJ}"
: "${LCZOJ_GITEE:=https://gitee.com/lichenzhen0713/LCZOJ}"
: "${LCZOJ_DIR:=/opt/lczoj}"
: "${LCZOJ_PORT:=}"
: "${LCZOJ_JUDGES:=4}"
CONTAINER=lczoj
VOLUME=lczoj-data

echo "=============================================="
echo "  LCZOJ Docker 一行部署"
echo "=============================================="

# ---------------- 1. 基础工具 ----------------
echo "① 安装基础工具（curl / tar / unzip / git）…"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y curl ca-certificates tar unzip git >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates tar unzip git >/dev/null 2>&1 || true
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates tar unzip git >/dev/null 2>&1 || true
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm curl ca-certificates tar unzip git >/dev/null 2>&1 || true
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ca-certificates tar unzip git >/dev/null 2>&1 || true
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive install curl ca-certificates tar unzip git >/dev/null 2>&1 || true
fi

# ---------------- 2. 自动安装 Docker ----------------
if ! command -v docker >/dev/null 2>&1; then
  echo "② 没有检测到 Docker，正在自动安装（官方脚本，约 1~3 分钟）…"
  # M18：下载 → 校验 SHA256（LCZOJ_DOCKER_INSTALL_SHA256 可固定期望值）→ 再执行
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || {
    echo "错误：下载 Docker 安装脚本失败，请检查网络后重试。" >&2; exit 1; }
  GOT_SHA=$(sha256sum /tmp/get-docker.sh 2>/dev/null | awk '{print $1}')
  if [ -n "${LCZOJ_DOCKER_INSTALL_SHA256:-}" ]; then
    if [ "$GOT_SHA" != "$LCZOJ_DOCKER_INSTALL_SHA256" ]; then
      echo "错误：Docker 安装脚本 SHA256 校验失败！期望 $LCZOJ_DOCKER_INSTALL_SHA256，实际 $GOT_SHA" >&2
      echo "      已拒绝执行（上游更新或被篡改，请人工确认）。" >&2
      rm -f /tmp/get-docker.sh; exit 1
    fi
    echo "   ✓ Docker 安装脚本 SHA256 校验通过（$GOT_SHA）"
  else
    echo "   ⚠ 未提供 LCZOJ_DOCKER_INSTALL_SHA256，无法校验 Docker 安装脚本来源完整性！"
    echo "     实际 SHA256 = ${GOT_SHA:-（计算失败）}"
    echo "     建议确认无误后设置该环境变量再重跑。"
  fi
  sh /tmp/get-docker.sh || { echo "错误：Docker 安装失败。" >&2; exit 1; }
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  echo "   Docker 安装完成 ✓"
else
  echo "② Docker 已安装 ✓（$(docker --version 2>/dev/null | head -n1)）"
fi
if ! docker info >/dev/null 2>&1; then
  systemctl start docker >/dev/null 2>&1 || true
  sleep 2
fi
docker info >/dev/null 2>&1 || {
  echo "错误：Docker 服务没起来，请执行 systemctl start docker 后重试。" >&2; exit 1; }

# 选用 docker compose（v2 插件）还是纯 docker 命令
COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
fi

# ---------------- 3. 下载项目 ----------------
export GIT_TERMINAL_PROMPT=0
if [ -f "$LCZOJ_DIR/server.js" ]; then
  echo "③ 检测到已有项目目录 $LCZOJ_DIR，正在更新代码（数据库在数据卷里，不受影响）…"
  (cd "$LCZOJ_DIR" && git pull --ff-only) >/dev/null 2>&1 || true
else
  echo "③ 下载 LCZOJ → $LCZOJ_DIR"
  mkdir -p "$(dirname "$LCZOJ_DIR")"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$LCZOJ_REPO" "$LCZOJ_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$LCZOJ_GITEE" "$LCZOJ_DIR" >/dev/null 2>&1 \
      || true
  fi
  if [ ! -f "$LCZOJ_DIR/server.js" ]; then
    echo "   Git 克隆失败，改用压缩包下载…"
    if curl -fsSL "${LCZOJ_REPO}/archive/refs/heads/master.tar.gz" -o /tmp/lczoj.tar.gz 2>/dev/null; then
      mkdir -p /tmp/lczoj-src && tar -xzf /tmp/lczoj.tar.gz -C /tmp/lczoj-src
      mv /tmp/lczoj-src/* "$LCZOJ_DIR" 2>/dev/null || true
    elif curl -fsSL "${LCZOJ_GITEE}/repository/archive/master.zip" -o /tmp/lczoj.zip 2>/dev/null; then
      mkdir -p /tmp/lczoj-src && unzip -qo /tmp/lczoj.zip -d /tmp/lczoj-src
      mv /tmp/lczoj-src/* "$LCZOJ_DIR" 2>/dev/null || true
    else
      echo "错误：下载项目失败，请检查仓库地址（LCZOJ_REPO / LCZOJ_GITEE）。" >&2; exit 1
    fi
    rm -rf /tmp/lczoj.tar.gz /tmp/lczoj.zip /tmp/lczoj-src
  fi
fi
[ -f "$LCZOJ_DIR/server.js" ] || { echo "错误：项目文件不完整（缺少 server.js）。" >&2; exit 1; }
cd "$LCZOJ_DIR"

# ---------------- 4/5. 构建镜像 + 启动容器 ----------------
# 端口：默认 80；被占用时自动改用 8080
if [ -z "$LCZOJ_PORT" ]; then
  if command -v ss >/dev/null 2>&1 && ss -lnt 2>/dev/null | grep -q ':80 '; then
    LCZOJ_PORT=8080
    echo "   注意：80 端口已被占用（多半是 Nginx / 宝塔），自动改用 8080"
  else
    LCZOJ_PORT=80
  fi
fi
VERSION="$(node -e "try{console.log(require('./package.json').version)}catch(e){console.log('latest')}" 2>/dev/null || echo latest)"
IMAGE="lczoj:${VERSION}"

echo "④ 构建镜像 $IMAGE（首次约 3~10 分钟，要下载基础镜像并安装评测语言）…"
docker build -t "$IMAGE" . || { echo "错误：镜像构建失败。" >&2; exit 1; }

echo "⑤ 启动容器（端口 ${LCZOJ_PORT} → 容器 80，数据卷 ${VOLUME}）…"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
  -p "${LCZOJ_PORT}:80" \
  -v "${VOLUME}:/app/data" \
  -e "OJ_MAX_JUDGES=${LCZOJ_JUDGES}" \
  -e "TZ=${TZ:-Asia/Shanghai}" \
  "$IMAGE" >/dev/null || { echo "错误：容器启动失败。" >&2; exit 1; }

# ---------------- 6. 等就绪 + 打印地址 ----------------
echo "⑥ 等待服务就绪…"
OK=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${LCZOJ_PORT}/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done

# 公网 IP：可用环境变量 LCZOJ_PUBLIC_IP 指定；否则依次查询多个公开源（国内可达性优先），失败则回退内网地址
# 注意：只接受较短响应（排除 HTML 页面）并严格校验四段 0~255、不允许前导零，避免误取页面里的其它数字
detect_public_ip() {
  for u in "https://ip.3322.net" "https://myip.ipip.net" "https://ifconfig.me/ip" "https://ipinfo.io/ip" "https://api.ipify.org" "https://ident.me" "https://4.ipw.cn"; do
    body="$(curl -fsS --max-time 6 "$u" 2>/dev/null | head -c 200 | tr -d '\r')"
    [ -n "$body" ] || continue
    ip="$(printf '%s' "$body" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | awk -F. 'NF==4 && $1<=255 && $2<=255 && $3<=255 && $4<=255 && $1 !~ /^0[0-9]/ && $2 !~ /^0[0-9]/ && $3 !~ /^0[0-9]/ && $4 !~ /^0[0-9]/ {print; exit}')"
    if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}
url_of() {
  if [ "$LCZOJ_PORT" = "80" ]; then printf 'http://%s/' "$1"; else printf 'http://%s:%s/' "$1" "$LCZOJ_PORT"; fi
}
PUBLIC_IP="${LCZOJ_PUBLIC_IP:-}"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(detect_public_ip || true)"
INTERNAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$INTERNAL_IP" ] || INTERNAL_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1)"

# 初始管理员密码：首次启动时随机生成，容器内落在数据卷的 admin-password.txt
ADMIN_PWD="$(docker exec "$CONTAINER" sh -c 'cat /app/data/admin-password.txt 2>/dev/null' 2>/dev/null | sed -n 's/^初始密码：//p' | head -n1)"

echo ""
echo "=============================================="
if [ "$OK" = "1" ]; then
  echo "  部署完成 ✓"
else
  echo "  容器已启动，但健康检查还没通过（首次启动可能较慢）"
  echo "  稍等片刻用浏览器打开，或看日志：docker logs -f ${CONTAINER}"
fi
echo "=============================================="
if [ -n "$PUBLIC_IP" ]; then
  echo "  公网地址：$(url_of "$PUBLIC_IP")   ← 外网访问用这个"
else
  echo "  公网地址：未能自动识别，请用服务器的公网 IP 访问（也可先 export LCZOJ_PUBLIC_IP=你的IP 再重跑本脚本）"
fi
[ -n "$INTERNAL_IP" ] && echo "  内网地址：$(url_of "$INTERNAL_IP")   ← 同一局域网内访问用这个"
echo "  提示：云服务器需在【安全组 / 防火墙】放行 ${LCZOJ_PORT} 端口，否则公网打不开"
if [ -n "$ADMIN_PWD" ]; then
  echo "  账号：admin　初始密码：${ADMIN_PWD}　（随机生成，登录后请立刻修改）"
else
  echo "  账号：admin　初始密码：首次启动时随机生成，见 docker logs ${CONTAINER}"
  echo "        （或查看容器内文件：docker exec ${CONTAINER} cat /app/data/admin-password.txt）"
  echo "        （若数据卷由旧版本创建，则仍为旧默认密码 admin123，请登录后立刻修改）"
fi
echo ""
echo "  常用命令："
echo "    docker logs -f ${CONTAINER}        看日志"
echo "    docker restart ${CONTAINER}        重启"
echo "    docker rm -f ${CONTAINER}          停止（数据卷保留）"
echo "    更新到新版本：node ${LCZOJ_DIR}/deploy/update.js --docker"
echo "    （或重新执行本脚本，会自动拉取新代码并重建）"
echo ""
echo "  想用自己的域名 + HTTPS：把域名解析到本机，再用 Nginx 反向代理到 127.0.0.1:${LCZOJ_PORT}"
echo "  配置示例见 ${LCZOJ_DIR}/deploy/nginx-lczoj.conf"
echo ""
