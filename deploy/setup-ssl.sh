#!/usr/bin/env bash
# =============================================================================
#  LCZOJ × 小皮面板 —— Let's Encrypt 一键签发 + 安装（webroot 模式）
#
#  用法（在服务器上以 root 执行）：
#      sudo EMAIL=你的邮箱 bash deploy/setup-ssl.sh
#      sudo EMAIL=你的邮箱 bash deploy/setup-ssl.sh oj.lichenzhen.cn /www/server/phpstudy/www/oj.lichenzhen.cn
#
#  它做什么：
#    1) 建好并授权 webroot 下的 .well-known/acme-challenge（ACME 校验目录）
#    2) 装 certbot（没有才装：apt / dnf / yum）
#    3) 用 **webroot 模式**签 Let's Encrypt 证书（不需要停 Nginx！）
#    4) 把 fullchain / privkey 复制到 /etc/nginx/ssl/ 固定路径（与 lczoj-https.conf 对应）
#    5) 装自动续期钩子（续期后自动复制证书 + 重载 Nginx）
#    6) 语法检查 + 重载 Nginx，并打印验证命令
#
#  前置：站点已用 deploy/nginx/lczoj-http.conf（或任何能让
#        http://域名/.well-known/acme-challenge/ 返回文件的配置）跑起来。
#        脚本第 1 步会先给出一条 curl 自检命令，返回 ok 才能继续。
# =============================================================================
set -euo pipefail

DOMAIN="${1:-oj.lichenzhen.cn}"
WEBROOT="${2:-/www/server/phpstudy/www/${DOMAIN}}"
CERTDIR="/etc/nginx/ssl"
LE_DIR="/etc/letsencrypt/live/${DOMAIN}"
EMAIL="${EMAIL:-}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo EMAIL=你的邮箱 bash $0"
[ -n "$EMAIL" ] || die "缺少邮箱：sudo EMAIL=you@example.com bash $0"

say "1/6 准备 ACME 校验目录：${WEBROOT}/.well-known/acme-challenge"
mkdir -p "${WEBROOT}/.well-known/acme-challenge"
# 面板用户通常是 www；没有 www 就退回当前用户
if id www >/dev/null 2>&1; then
  chown -R www:www "${WEBROOT}" || true
  chmod -R 755 "${WEBROOT}" || true
else
  warn "系统里没有 www 用户，跳过 chown（如面板用其它用户请手动 chown）"
fi
printf 'ok\n' > "${WEBROOT}/.well-known/acme-challenge/test"
ok "已写入测试文件"
warn "请先在浏览器/终端确认这一条能取到 ok（取不到就先修配置，别继续）："
printf '    curl -s http://%s/.well-known/acme-challenge/test\n' "$DOMAIN"

say "2/6 检查 certbot"
if command -v certbot >/dev/null 2>&1; then
  ok "certbot 已安装：$(certbot --version 2>&1)"
else
  warn "未安装，开始安装（可能耗时 1~2 分钟）"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y certbot
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot
  elif command -v yum >/dev/null 2>&1; then
    yum install -y certbot
  else
    die "找不到 apt/dnf/yum，请手动安装 certbot 后重跑"
  fi
  ok "certbot 安装完成"
fi

say "3/6 用 webroot 模式签发 Let's Encrypt 证书"
warn "如果这里报 404/unauthorized：说明 http://${DOMAIN}/.well-known/... 还没通"
warn "  → 检查 webroot 是否与站点配置里的 root 一致；或先只启用 lczoj-http.conf"
certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --agree-tos --no-eff-email --non-interactive -m "$EMAIL" --keep-until-expiring
[ -d "$LE_DIR" ] || die "签发后找不到 $LE_DIR，请查看 certbot 输出"
ok "证书已签发：$LE_DIR"

say "4/6 安装证书到固定路径 ${CERTDIR}"
mkdir -p "$CERTDIR"
cp -L "${LE_DIR}/fullchain.pem" "${CERTDIR}/${DOMAIN}.pem"
cp -L "${LE_DIR}/privkey.pem"   "${CERTDIR}/${DOMAIN}.key"
chmod 644 "${CERTDIR}/${DOMAIN}.pem"
chmod 600 "${CERTDIR}/${DOMAIN}.key"
ok "${CERTDIR}/${DOMAIN}.pem （fullchain）"
ok "${CERTDIR}/${DOMAIN}.key （私钥，600）"

say "5/6 安装自动续期钩子（续期后自动同步证书 + 重载 Nginx）"
HOOK="/etc/letsencrypt/renewal-hooks/deploy/lczoj-${DOMAIN}.sh"
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<HOOKEOF
#!/usr/bin/env bash
# 由 LCZOJ deploy/setup-ssl.sh 自动生成
set -e
cp -L "${LE_DIR}/fullchain.pem" "${CERTDIR}/${DOMAIN}.pem"
cp -L "${LE_DIR}/privkey.pem"   "${CERTDIR}/${DOMAIN}.key"
chmod 644 "${CERTDIR}/${DOMAIN}.pem"; chmod 600 "${CERTDIR}/${DOMAIN}.key"
nginx -t && nginx -s reload || true
HOOKEOF
chmod +x "$HOOK"
ok "钩子：$HOOK"

if command -v systemctl >/dev/null 2>&1; then
  systemctl list-timers 2>/dev/null | grep -q certbot && ok "已存在 certbot 续期定时器" \
    || warn "没看到 certbot.timer，启用一下：systemctl enable --now certbot.timer"
fi

say "6/6 语法检查 + 重载 Nginx"
if nginx -t; then
  nginx -s reload || true
  ok "Nginx 已重载"
else
  warn "nginx -t 失败：多半是还引用着「阶段 1」的配置或证书路径不对，见下面指引"
fi

cat <<EOF

────────────────────────────────────────────────────────
  完成。接下来两步：
  ① 把站点配置换成 deploy/nginx/lczoj-https.conf（80 + 443），然后：
       sudo nginx -t && sudo nginx -s reload
  ② 验证：
       curl -I https://${DOMAIN}/          # 期望 200
       curl -I http://${DOMAIN}/           # 期望 301 到 https

  续期：certbot 会每 60 天自动续期（systemd timer），钩子会自动同步证书并重载 Nginx。
  手动演练：sudo certbot renew --dry-run
────────────────────────────────────────────────────────
EOF
