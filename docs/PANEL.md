# 面板部署（宝塔面板 / 小皮面板）

本文说明在宝塔面板与小皮面板上部署 LCZOJ 的步骤。

**部署模型**：面板站点（Nginx）占用 80 / 443 端口，LCZOJ 监听 3000 端口，由站点以反向代理转发请求。

---

## 1. 部署流程概览

| 步骤 | 操作 | 执行方 |
| --- | --- | --- |
| ① 安装 Node.js | 在面板软件商店安装 **v24** | 手动，约 1 分钟 |
| ② 执行准备命令 | `node deploy/panel-install.js`：准备环境、后台启动服务、生成反向代理配置 | 脚本自动 |
| ③ 配置站点 | 将生成的 `deploy/panel-nginx.conf` 内容合并到站点配置，并申请 SSL 证书 | 手动，约 1 分钟 |

命令执行完成后会输出服务就绪状态与后续操作清单。

> 反向代理和 SSL 都备好了现成配置，不必手写：**3.5.1** 选了用哪份 Nginx 配置，**3.7** 讲两条签证书路线。顺序是「先用 80 的配置跑通 → 签证书 → 再换 443 的配置」。

---

## 2. 宝塔面板（Linux）

### 2.1 安装 Node.js v24

1. 左侧「软件商店」→ 搜索并安装 **Node.js 版本管理器**（部分版本名为 **PM2管理器**）；
2. 打开该插件 → 安装 **Node 版本 v24** → 设为默认版本。

注意事项：LCZOJ 使用 Node.js 内置的 `node:sqlite` 模块，要求 Node.js ≥ 22.5（推荐 v24）；版本过低时启动会报 `Cannot find module 'node:sqlite'`。

### 2.2 上传项目并执行准备命令

1. 左侧「文件」→ 进入 `/www/wwwroot/` → 新建目录（建议以域名命名，例如 `oj.example.com`）；
2. 上传项目压缩包并解压，解压后该目录下应直接包含 `server.js`、`src`、`public`、`deploy`；
3. 打开左侧「终端」，依次执行：

```bash
cd /www/wwwroot/oj.example.com     # 替换为实际目录
chown -R www:www .
node deploy/panel-install.js       # 准备环境 + 后台启动服务 + 生成反向代理配置
```

该命令依次执行：检查 Node.js 版本 → 创建数据目录并修正属主 → 写入启动参数 `deploy/panel.env` → 安装评测语言编译器 → 后台启动服务并等待健康检查通过 → 生成 `deploy/panel-nginx.conf`。

常用附加参数：`--check`（仅检查环境，不修改文件）、`--start` / `--stop`（启动 / 停止后台服务）、`--port`（指定端口）。

### 2.3 配置站点反向代理

方式 A（使用面板的反向代理功能）：进入目标站点 → 「反向代理」→「添加反向代理」，填写：

| 字段 | 值 |
| --- | --- |
| 代理名称 | `lczoj` |
| 目标 URL | `http://127.0.0.1:3000` |
| 发送域名 | `$host` |

方式 B（直接编辑站点配置）：进入目标站点 → 「配置文件」，将 `deploy/panel-nginx.conf` 的内容合并到 `server { }` 中，并修改 `server_name` 为实际域名。该配置已包含 `client_max_body_size 64m;`（缺少此项时上传较大答案包会返回 413）。

保存后通过域名访问站点。

> 不想手写：直接用 **3.5.1** 里 `deploy/nginx/` 下的现成配置（宝塔与小皮通用），只改域名 / 站点根目录 / 证书路径 3 处。

> 还没有域名时可以先直接用 `http://服务器公网IP:端口/` 访问（脚本会打印公网地址；自动识别失败时用 `LCZOJ_PUBLIC_IP=你的IP` 指定）。
> 管理员账号为 `admin`，**初始密码在首次启动时随机生成**：启动日志会打印一次，也写在数据目录的 `admin-password.txt`。

### 2.4 申请 SSL 证书

站点 → 「SSL」→ 「Let's Encrypt」→ 勾选域名 → 申请 → 开启「强制 HTTPS」。

> ⚠ 纯反代站点直接点申请常失败：面板的 ACME 校验请求会被转给 LCZOJ，而 LCZOJ 没有那个校验文件 → **返回 404** → 申请不通过。解决办法（加一段 `location ^~ /.well-known/acme-challenge/` + 自测 `curl`）见 **3.7.1**；也可以跳过面板、用仓库脚本签发，见 **3.7.2**。

### 2.5 交由面板托管进程（可选）

`panel-install.js` 已在后台启动服务，进程号记录于 `deploy/panel.pid`。如需由面板托管并提供开机自启：

```bash
node deploy/panel-install.js --stop       # 先停止脚本启动的进程
```

随后在「网站 → Node 项目 → 添加」中填写：项目目录为站点目录，启动命令为 `bash deploy/panel-start.sh`，端口 `3000`，运行用户 `www`。也可使用 PM2：

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
```

---

## 3. 小皮面板（phpStudy 面板）

### 3.0 三步快路径（推荐，十分钟内上线）

> 下面的 3.1~3.10 是完整体（含参数、故障、验收），**首次部署照这三步就够**。

```
① 装 Node v24（面板软件商店有 Node 版本管理就一键装；否则 nodejs.org 下 .msi，勾 Add to PATH，重开终端）
     验证：node -v   →  v24.x

② 双击项目里的 deploy\xiaopi-onekey.bat
     （等价于 node deploy/xiaopi-onekey.js；想换端口加 --port 8080）
     它会自动准备数据目录、写好启动参数、后台启动、并生成 deploy/xiaopi.conf
     ★ 结束时屏幕上会打印 admin 初始密码，记下来

③ 小皮面板 → 网站 → 创建网站（填域名，PHP 随便选）→ 该站点「配置文件」→
     把屏幕上那 9 行（也存于 deploy/xiaopi.conf）粘进 server { } → 重载配置 →
     浏览器打开 http://你的域名/ ，用 admin + 初始密码登录并改密码
```

**只要记住一句**：面板管域名和证书，LCZOJ 自己跑在 `127.0.0.1:3000`，中间用反代连起来。

常用的就三个命令：

| 命令 | 作用 |
| --- | --- |
| `deploy\xiaopi-onekey.bat --check` | 只看环境（不改文件、不启动） |
| `deploy\xiaopi-onekey.bat` | 一键准备好并后台启动 |
| `node deploy\update.js` | 升级到新版本（先备份数据库） |



小皮面板以 PHP 环境为主，本站不使用 PHP —— **面板只负责域名、证书与反向代理**；LCZOJ 自己监听 `3000` 端口，由面板的 Nginx（或 Apache）转发过去。

> 为什么不用 80 端口直连：小皮面板的站点/面板本身要占用 80 与 443，把 OJ 也设成 80 会冲突。标准做法就是 `OJ_HOST=127.0.0.1` + `PORT=3000` + 反代。

### 3.1 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.5**（项目用 Node 内置的 `node:sqlite`，低于 22.5 直接起不来；推荐 **v24**） |
| 磁盘 | 代码 + 依赖 0（**无需 `npm install`**）；预留 `data/` 与判题缓存空间 |
| 端口 | 面板占 80/443；OJ 用 **3000**（可改） |
| 系统 | Windows（小皮 Windows 版）或 Linux（小皮 Linux 版），命令基本一致 |

### 3.2 安装 Node.js

1. 打开面板「软件商店」，若有 **Node.js / Node 版本管理**，直接安装 **v24**；
2. 否则手动装：
   - **Windows**：<https://nodejs.org/zh-cn/download> 下载 v24 的 `.msi`，安装时勾选 **Add to PATH**；装完**重新打开面板终端**（旧窗口读不到新的环境变量）；
   - **Linux**：`curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`。
3. 验证（必须看到 v22.5 以上）：
   ```bash
   node -v
   ```

### 3.3 上传代码

1. 解压到站点目录：
   - Windows 默认 `C:\phpstudy_pro\WWW\lczoj`
   - Linux 默认 `/www/wwwroot/lczoj`
   - 路径建议**纯英文、无空格**；
2. 解压后目录里应能看到：`server.js`、`package.json`、`public/`、`src/`、`deploy/`、`docs/`；
3. **不需要** `npm install`（零 npm 依赖）。

### 3.4 一键准备 + 启动

```bash
cd /d C:\phpstudy_pro\WWW\lczoj      # Linux: cd /www/wwwroot/lczoj
node deploy\panel-install.js --check   # 可选：只检查环境，什么都不改
node deploy\panel-install.js           # 一键准备 + 后台启动
```

它会依次完成：检查 Node 版本 → 建 `data/` 并验可写 → 写 `deploy/panel.env`（`PORT=3000`、`OJ_HOST=127.0.0.1`、`OJ_MAX_JUDGES=4`）→ 尝试安装评测语言编译器 → 启动服务（`deploy/panel.pid`，日志 `logs/lczoj.log`）→ 生成可直接粘贴的 `deploy/panel-nginx.conf` → 跑环境自检 → 列出面板上接下来点哪里。

**首次启动会打印管理员初始密码**（同时写入 `data/admin-password.txt`，仅首次生成）：

```
管理员账号: admin　初始密码: xxxxxxxx
```

> 记下它，登录后**立刻改密码**。忘了见 `docs/FAQ.md` 的重置方法。

常用参数：

| 命令 | 作用 |
| --- | --- |
| `node deploy\panel-install.js --start` / `--stop` | 只启动 / 停止后台服务 |
| `--port 8080` | 换端口（要与反代保持一致） |
| `--host 0.0.0.0` | 允许不经反代、直接用 `IP:端口` 访问 |
| `--no-compilers` | 跳过评测语言安装 |
| `node deploy\check-env.js` | 环境自检（判题语言是否可用等） |

### 3.5 建站 + 反向代理

1. 面板 →「网站」→「创建网站」，填域名，**PHP 版本任选**（本站不使用 PHP）；
2. 进入站点 →「配置文件」，把 `deploy/panel-nginx.conf` 的内容合并进 `server { }`，并把 `server_name` 改成你的域名（想用带 ACME / 443 的完整版，直接取 3.5.1 里的文件）；
   若面板提供「反向代理」入口，也可直接新建：目标 URL `http://127.0.0.1:3000`，发送域名 `$host`；
3. 三个关键项（少了会出故障）：
   ```nginx
   client_max_body_size 64m;        # 太小 → 上传答案包/提交大代码报 413
   location / { proxy_pass http://127.0.0.1:3000;
                proxy_http_version 1.1;
                proxy_read_timeout 300s;   # 必须大于服务端 keepAliveTimeout(65s)
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme; }
   ```
4. 若小皮用的是 **Apache**，启用 `mod_proxy` / `mod_proxy_http` 后改用：
   ```apache
   ProxyPreserveHost On
   ProxyPass        / http://127.0.0.1:3000/ retry=0 timeout=300
   ProxyPassReverse / http://127.0.0.1:3000/
   ```
5. **重载 Nginx / 重启 Apache** 使配置生效。

#### 3.5.1 现成配置文件（推荐：直接挑一份，别自己拼）

| 文件 | 什么时候用 | 怎么用 |
| --- | --- | --- |
| `deploy/nginx/lczoj-http.conf` | 证书**还没签**。只有 80：ACME 校验 + 全站反代 | **整份替换**站点配置；自带一个 `upstream`，别再叠 |
| `deploy/nginx/lczoj-https.conf` | 证书**已签好**。80 跳 443，443 反代 | 整份替换掉阶段 1 那份；同样自带 `upstream` |
| `deploy/nginx/lczoj-https-final.conf` | 同样是「80 + 443」完整版，但面板站点里已经有一份 `upstream` 时用它 | 整份替换。它刻意**不含** `upstream`、`http2 on;`、server 级 `root/index/try_files`、`location ~ \.php$`，最不容易把 Nginx 搞挂 |
| `deploy/vhost-oj.lichenzhen.cn.conf` | 想照着一个真实站点抄（域名 `oj.lichenzhen.cn`） | 改 3 处即可用 |

**改哪 3 处**（以 vhost 示例为例）：① 域名 `oj.lichenzhen.cn`；② 站点根目录 `/www/server/phpstudy/www/oj.lichenzhen.cn`（出现在 ACME 的 `root` 里，要和面板「网站目录」完全一致）；③ 证书路径 `ssl_certificate` / `ssl_certificate_key`。改完：

```bash
sudo nginx -t && sudo nginx -s reload
```

> 这四份都是**整份替换**站点配置用的，不是「往已有 server 里贴一段」。区别只在稳妥程度：一份站点配置里只能有一个同名 `upstream`，`lczoj-http.conf` / `lczoj-https.conf` 各自带一个，别再多加；`lczoj-https-final.conf` 干脆不带。

#### 3.5.2 ⚠ 403 与「Nginx 起不来」的四个根因

反代站点的配置里，下面四样东西**一律不要出现**（很多人的 403 就是这么来的）：

- **`upstream { }` 写了第二份** → `nginx -t` 报 `duplicate upstream "lczoj_backend"`，Nginx 起不来、整站挂掉。阶段配置已自带一份，别再加；已有站点的用 `lczoj-https-final.conf`（它本来就不带）。
- **`http2 on;`** → Nginx < 1.25.1 没有这个指令，报 `unknown directive "http2"`，同样起不来。老版本改写成 `listen 443 ssl http2;`，**两者不要同时写**（新版本认 `http2 on;`，老版本只认 `listen ... http2`）。
- **server 级的 `root` / `index index.php` / `try_files`** → 请求被当成静态文件去目录里找，找不到默认首页就 **403**（`try_files` 那种写法多为 404）。这不是权限问题，是这几行抢走了请求；删掉，只留 `location / { proxy_pass ... }`。
- **`location ~ \.php$ { ... }`** → 正则 location 比 `location /` 优先，PHP 那段会抢走所有 `.php` 请求；本站不用 PHP，删掉。

改完核对「最终生效的配置」里没残留这些行：

```bash
sudo nginx -t                                  # 先过语法
sudo nginx -T | grep -A30 'server_name 你的域名' | grep -E 'root|index|try_files|php|upstream'
```

### 3.6 防火墙放行（Windows）

```powershell
netsh advfirewall firewall add rule name="LCZOJ-80"  dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="LCZOJ-443" dir=in action=allow protocol=TCP localport=443
```

云服务器还要在**安全组**里放行 80/443（不建反代、直接用端口访问时放行 3000）。

### 3.7 申请 SSL

两条路线，任选一条；都**不需要停 Nginx**：

| 路线 | 适合 | 入口 |
| --- | --- | --- |
| 路线 1：面板自带 Let's Encrypt | 想点几下就完事 | 站点 →「SSL / 证书」→ Let's Encrypt |
| 路线 2：`deploy/setup-ssl.sh`（certbot webroot） | 面板申请老 404，或想连自动续期一起配好 | 服务器终端一条命令 |

#### 3.7.1 路线 1：面板自带 Let's Encrypt（先解决 404）

站点 →「SSL / 证书」→ 申请 **Let's Encrypt** 免费证书 → 开启**强制 HTTPS**。

面板的 ACME 校验走 `http://你的域名/.well-known/acme-challenge/<token>`。**纯反代的站点会把这条请求转给 LCZOJ，而 LCZOJ 没有该文件 → 返回 404 → 申请失败**（面板通常提示「验证失败 / unauthorized」）。修法是在站点配置里、`location /` **之前**加这一段：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root <站点根目录>;                # 例：/www/server/phpstudy/www/oj.lichenzhen.cn
    default_type text/plain;
    try_files $uri =404;
}
```

`^~` 让它优先于 `location /`，校验请求才会读本地文件而不是被反代走。然后建目录、授权、**先自测再点申请**：

```bash
sudo mkdir -p <站点根目录>/.well-known/acme-challenge
sudo chown -R www:www <站点根目录>/.well-known/acme-challenge   # 面板运行用户，宝塔同样是 www
echo ok | sudo tee <站点根目录>/.well-known/acme-challenge/test
curl -s http://你的域名/.well-known/acme-challenge/test         # 必须回 ok
```

回 `ok` 再去点「申请」；仍回 404 就说明 `root` 与面板里的「网站目录」不一致，改成一致再试。签好后证书路径**以面板显示的为准**（常见 `/www/server/phpstudy/vhost/cert/<域名>/`），填进 3.5.1 的 443 配置里。

#### 3.7.2 路线 2：`deploy/setup-ssl.sh`（webroot 签发 + 自动续期）

```bash
sudo EMAIL=你的邮箱 bash deploy/setup-ssl.sh 你的域名 /站点根目录
```

只给域名时，站点根目录默认 `/www/server/phpstudy/www/<域名>`。必须是 **root** 运行，且必须带 `EMAIL`，缺一个脚本会直接退出并提示。

脚本依次做 6 步（对应脚本里的 `1/6`~`6/6`）：

1. 建 `<站点根目录>/.well-known/acme-challenge`，写入测试文件 `test`，属主改成 `www`（没有 `www` 用户则跳过并提示），然后**打印一条 `curl` 自测命令**——这条不通就别往下走；
2. 没有 certbot 就按 `apt` / `dnf` / `yum` 自动安装；
3. `certbot certonly --webroot -w <站点根目录> -d <域名> --agree-tos --no-eff-email --non-interactive -m <EMAIL> --keep-until-expiring` —— **webroot 模式，不停 Nginx**；
4. 把 fullchain / privkey 复制到 `/etc/nginx/ssl/<域名>.pem` 与 `.key`（权限 644 / 600），正好是 `lczoj-https.conf` 里引用的路径；
5. 安装续期钩子 `/etc/letsencrypt/renewal-hooks/deploy/lczoj-<域名>.sh`：以后每次续期都会自动同步证书并 `nginx -t && nginx -s reload`；
6. `nginx -t` 通过就重载 Nginx，最后打印验证命令。

跑完按提示把站点配置换成 `deploy/nginx/lczoj-https.conf`，再：

```bash
sudo nginx -t && sudo nginx -s reload
curl -I https://你的域名/     # 期望 200
curl -I http://你的域名/      # 期望 301 到 https
```

> 前置条件：80 端口已用**阶段 1**（`deploy/nginx/lczoj-http.conf`）跑通、`.well-known` 能取到文件。否则第 3 步必然报 404 / unauthorized——那不是 certbot 的问题，是校验路径没通。

#### 3.7.3 443 的四个注意点

- **证书路径用真实路径**：`lczoj-https.conf` 默认写 `/etc/nginx/ssl/<域名>.pem|.key`（`setup-ssl.sh` 的产物）；用面板签的就换成面板给的路径，别照抄示例域名。文件不存在时 `nginx -t` 会报 `cannot load certificate`。
- **老版本 Nginx（< 1.25.1）**：把 `http2 on;` 换成 `listen 443 ssl http2;`；两个不要同时写（新版本认前者，老版本只认后者）。不确定就先不开 HTTP/2，HTTP/1.1 完全够用。
- **放行 443**：`sudo ufw allow 443/tcp`，或 `sudo firewall-cmd --add-service=https --permanent && sudo firewall-cmd --reload`；云服务器还要在**安全组**里放行 443。
- **`X-Forwarded-Proto` 别删**：OJ 靠它识别请求是 https，删了会导致跳转 / 回调地址错乱。

### 3.8 开机自启（可选，二选一）

- **面板计划任务**（推荐，Windows）：面板 →「计划任务」→ 添加任务
  - 执行程序：`cmd`
  - 参数：`/c "cd /d C:\phpstudy_pro\WWW\lczoj && deploy\panel-start.bat"`
  - 触发方式：**开机启动**（或每分钟检测进程是否存活）
- **PM2**：`pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup`
  （自行用 PM2 托管时，先 `node deploy\panel-install.js --stop` 停掉脚本启动的进程，避免两份）

### 3.9 验收清单（逐项打勾）

- [ ] `http://你的域名/` 能打开首页，且 `/api/health` 返回 `{"success":true,"status":"up"}`
- [ ] 用 `admin` + 初始密码登录成功，**已修改密码**
- [ ] 后台「系统设置」→ 站点名称/Logo 能保存
- [ ] 提交一次 Python 题解并得到 AC（未装的语言在提交页显示「未安装」）
- [ ] 上传较大的答案包（>32MB）不报 **413**（`client_max_body_size 64m` 已生效）
- [ ] 页面时间显示为东八区（`TZ=Asia/Shanghai`）
- [ ] 重启机器后面能自动恢复（计划任务/PM2 生效）

### 3.10 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 站点打不开、反代 **502** | 服务没起：`node deploy\panel-install.js --start`；或反代端口与 `deploy/panel.env` 的 `PORT` 不一致；CentOS 上被 SELinux 拦：`sudo setsebool -P httpd_can_network_connect 1` |
| 反代后 **403**（首页就 403，`/api/health` 也 403） | 站点配置里还留着 `root` / `index index.php` / `try_files`，请求被当静态文件处理。删掉，只留 `location / { proxy_pass ... }`，详见 3.5.2 |
| 本机 `curl 127.0.0.1:3000` 通、外网不通 | 防火墙/安全组没放行 80/443 |
| 报 `node:sqlite` / 启动即退出 | Node 版本 < 22.5，装 v24 |
| 上传报 **413** | 站点配置缺 `client_max_body_size 64m;`（放在 `server { }` 里；`deploy/xiaopi.conf` 第一行就是它） |
| **Nginx 起不来 / 站点全挂** | 先看 `sudo nginx -t` 报的是哪一行：`unknown directive "http2"` → 删 `http2 on;`（老版本改 `listen 443 ssl http2;`）；`duplicate upstream` → 多了一份 `upstream`；分号 / 括号不配对。按报错行改完再 reload |
| 面板申请证书一直失败 | ACME 校验被反代成 404，见 3.7.1；或直接用 3.7.2 的脚本签发 |
| 设置页**版本号不刷新** | 版本号在服务启动时读取，升级后必须重启服务：`node deploy\panel-install.js --stop` 再 `--start` |
| 判题一直 Pending / 语言「未安装」 | Windows 需自己装 Python / Dev-Cpp（含 g++），装完 `node deploy\check-env.js` 复核 |
| 忘记管理员密码 | 见 `docs/FAQ.md`（不会明文保存，需按文档重置） |
| 想换端口 | `node deploy\panel-install.js --port 8080`，同步改反代 `proxy_pass` |
| 更新到新版本 | `node deploy\update.js`（会先备份数据库再覆盖代码并重启） |

---

## 4. 版本更新

```bash
node deploy/update.js            # 检查新版本 → 备份数据库 → 覆盖代码 → 自动重启
node deploy/update.js --check    # 仅检查是否有新版本
```

脚本会自动识别服务启动方式（PM2 / systemd / `deploy/panel.pid`）并执行对应重启操作。数据目录 `data/` 不受影响。

使用内置 `admin` 账号登录后，也可在「系统设置（`#/settings`） → 版本更新」中完成同样的操作。
完整说明见 [UPDATE.md](UPDATE.md)。

---

## 5. 启动参数

参数保存在 `deploy/panel.env`（由 `panel-install.js` 生成），修改后执行 `--stop` 再 `--start` 生效：

```ini
PORT=3000              # 服务端口；面板站点的 80/443 由 Nginx 使用，故此处使用 3000
OJ_HOST=127.0.0.1      # 仅允许本机访问（由 Nginx 反向代理），安全性更高
OJ_MAX_JUDGES=4        # 并行判题数，按服务器核数调整，建议保留 1~2 核给系统
TZ=Asia/Shanghai       # 时区（影响页面显示时间）
```

修改 `PORT` 后需同步修改反向代理的目标地址，否则会出现 502。

---

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node.js 版本过低，安装 v24；或临时将启动命令改为 `node --experimental-sqlite server.js` |
| 502 Bad Gateway | 后端未启动或端口不一致。先执行 `node deploy/panel-install.js --start` 确认就绪，再查看日志 `logs/lczoj.log`（PM2 用户：`pm2 logs lczoj`） |
| 直接访问 `IP:3000` 无响应，域名可访问 | 属正常现象：`OJ_HOST=127.0.0.1` 表示仅允许本机访问 |
| 页面样式异常 | 反向代理「目标 URL」不应包含路径，应为 `http://127.0.0.1:3000` |
| 上传答案压缩包报 413 | 站点配置中增加 `client_max_body_size 64m;`（生成的 `panel-nginx.conf` 已包含） |
| 域名访问直接 **403** | 站点配置残留 server 级 `root` / `index` / `try_files`，请求被当静态文件；删掉只留反代（见 3.5.2） |
| `nginx -t` 报 `unknown directive "http2"` / `duplicate upstream` | 删掉 `http2 on;`（老版本改 `listen 443 ssl http2;`）或多出来的那份 `upstream`，再 reload（见 3.5.2） |
| 题库保存失败或数据库报错 | `data` 目录权限不足：`chown -R www:www 项目目录/data`；Windows 在面板权限设置中为站点用户授予读写权限 |
| 页面时间相差 8 小时 | 在 `deploy/panel.env` 中设置 `TZ=Asia/Shanghai` 后重启服务 |
| 提交后长期处于「判题中」 | 缺少该语言的编译器（`node deploy/check-env.js` 会标记），或重启服务时打断了评测；重新提交即可 |
| 服务器重启后站点未启动 | 按第 2.5 / 3.8 节配置开机自启（Node 项目 / PM2 / 计划任务） |

---

## 7. 备份与迁移

### 7.1 备份什么

**完整备份 = 整个 `data/` 目录**：数据库 `oj.db`、题库测试数据 `testdata/`、题目附件 `attachments/`、用户头像 `avatars/`，以及 `admin-password.txt`。代码不用备份（重新下载即可），但面板的反向代理配置建议留一份。

### 7.2 更新器自带的备份（只管数据库）

内置更新（后台「一键更新」或 `node deploy/update.js`）**只覆盖代码，不覆盖 `data/`**；并且在动手前先把数据库复制一份到：

```
data/backup/oj-<旧版本>-<时间戳>.db      例：data/backup/oj-2.9.1-2026-11-08-03-18-24.db
```

只保留**最近 10 份**，更早的自动删除。`node deploy/update.js --no-backup` 可跳过（不建议）。

> 这层备份**只含数据库**，不含测试数据、附件、头像，也不能替代 7.4 的定时备份。

### 7.3 从备份恢复数据库（命令可直接粘）

```bash
cd /www/wwwroot/oj.example.com          # 换成你的项目目录
ls -lt data/backup/                     # 先挑一份：文件名里的版本号 + 时间戳
node deploy/panel-install.js --stop     # ① 先停服务，别边写边换

cp data/backup/oj-2.9.1-2026-11-08-03-18-24.db data/oj.db   # ② 覆盖数据库
rm -f data/oj.db-wal data/oj.db-shm                          # ③ 必须删：残留的 WAL 会让恢复看起来没生效

node deploy/panel-install.js --start    # ④ 重启，日志看 logs/lczoj.log
```

Windows（小皮）把后三步换成：

```bat
copy /Y data\backup\oj-2.9.1-2026-11-08-03-18-24.db data\oj.db
del /Q data\oj.db-wal data\oj.db-shm
node deploy\panel-install.js --start
```

> 不是面板脚本托管的（systemd / PM2）就换停启命令：`sudo systemctl stop lczoj` / `sudo systemctl start lczoj`，或 `pm2 stop lczoj && pm2 start lczoj`。

> 恢复会丢掉那份备份之后的提交、题目与用户改动，只在确有必要时用。想连附件 / 测试数据一起回退，就把整个 `data/` 目录（或 7.4 的 tar 包）解回去。

### 7.4 每日定时备份（建议加上，保留 14 天）

`data/backup/` 在 `data/` 里面，所以必须往**`data/` 之外**再备一份。Linux 用 cron：

```bash
sudo mkdir -p /root/lczoj-backup
sudo crontab -e
```

在打开的编辑器里加一行（**crontab 里的 `%` 必须写成 `\%`**）：

```cron
30 3 * * * cd /www/wwwroot/oj.example.com && tar czf /root/lczoj-backup/data-$(date +\%F).tar.gz data && find /root/lczoj-backup -name 'data-*.tar.gz' -mtime +14 -delete
```

含义：每天 03:30 把 `data/` 打成 `data-2026-11-08.tar.gz`，并删掉 14 天前的包。测试一次不必等定时：把整行命令手工执行一遍，看 `/root/lczoj-backup/` 里是否出现当天的包。

Windows / 不想用 cron：面板 →「计划任务」→ 添加「备份网站 / 备份目录」任务，选项目录下的 `data`，保留份数按需设置。

### 7.5 迁移到新服务器

新服务器按本文完成部署（Node v24 → `panel-install.js` → 反代 → 证书）后：

1. `node deploy/panel-install.js --stop` 停掉新机服务；
2. 用备份的 `data/` **覆盖**新机的 `data/`（别删目录再拷，直接覆盖）；
3. 确认属主（Linux：`chown -R www:www data`）；
4. `node deploy/panel-install.js --start`，用原管理员账号登录验证。

> ⚠ **`data/` 整个丢了就全丢了**：`data/backup`、`admin-password.txt` 都在里面。误删目录、磁盘损坏、`rm -rf` 项目目录都会连带清掉它们——所以 7.4 的外部定时备份不是可选项。

---

## 8. 其它部署方式

- Docker（一键脚本，未安装 Docker 时自动安装）：[DOCKER.md](DOCKER.md)
- 普通 Linux（一键脚本 / systemd）：[DEPLOYMENT.md](DEPLOYMENT.md)
- 现成 Nginx 配置（阶段 1 / 阶段 2 / 完整版 / vhost 示例）：`deploy/nginx/` 与 `deploy/vhost-oj.lichenzhen.cn.conf`，用法见 3.5.1
- SSL 一键签发脚本：`deploy/setup-ssl.sh`，用法见 3.7.2
- 版本更新与回滚：[UPDATE.md](UPDATE.md)
- 环境自检：`node deploy/check-env.js`
