# Docker 部署

本文说明 LCZOJ 的 Docker 部署方式。镜像内已包含全部评测语言工具链，服务器无需安装 Node.js 与编译器。

> 全新服务器可直接使用一行脚本（未安装 Docker 时会自动安装）：
> ```bash
> # GitHub 源
> curl -fsSL https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/docker-bootstrap.sh | sudo bash
>
> # Gitee 源（国内网络环境更快）
> curl -fsSL https://gitee.com/lichenzhen0713/LCZOJ/raw/master/docker-bootstrap.sh | sudo bash
> ```
> 该脚本依次完成：安装基础工具 → 安装并启动 Docker → 下载项目至 `/opt/lczoj` → 构建镜像 → 启动容器 → 等待服务就绪 → 输出**公网访问地址**与初始管理员密码。执行完成后可跳至第 3 节。

---

## 1. 前置条件：Docker 可用

项目已在服务器上时，在项目目录执行一键脚本：

```bash
node deploy/docker-onekey.js
```

该脚本会先检查 Docker 是否可用；未安装时的处理方式如下：

| 系统 | 处理方式 |
| --- | --- |
| Linux | 使用官方脚本自动安装，并执行 `systemctl enable --now docker`；无 root / sudo 权限时输出需要手动执行的命令 |
| Windows | 无法自动安装，输出 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 下载地址；安装时需勾选 WSL2，安装完成后重启终端 |
| macOS | 同上，安装 Docker Desktop |

不使用自动安装时可加参数 `--no-install-docker`。手动安装命令（Linux）：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

验证安装：

```bash
docker --version
```

---

## 2. 部署

```bash
node deploy/docker-onekey.js
```

脚本执行内容：构建镜像 → 选择可用端口（优先 80，被占用时自动改用 8080 并说明原因）→ 启动容器 → 轮询 `/api/health` 直至服务就绪 → 输出**公网地址**、内网地址与账号信息。

服务器未安装 Node.js 时，可使用等价命令：

```bash
docker compose up -d --build
```

启动后访问 **`http://服务器公网IP`**（脚本会直接打印公网地址；自动识别失败时用 `LCZOJ_PUBLIC_IP=你的IP` 指定）。若 80 端口已被 Nginx 占用，将 `docker-compose.yml` 中的 `"80:80"` 改为 `"8080:80"`，访问 `http://服务器IP:8080`。

首次构建需 3~10 分钟（下载基础镜像并安装评测语言），期间无输出属正常现象。

---

## 3. 部署后的初始操作

1. 访问站点，用 `admin` + 随机初始密码登录并立即修改密码（初始密码在启动日志里打印，或执行 `docker exec lczoj cat /app/data/admin-password.txt` 查看）；
2. 确认评测语言：系统设置（`#/settings`） → 评测性能，或执行 `node deploy/check-env.js`；
3. 确认数据位置：所有数据保存在数据卷 `lczoj-data` 中，删除容器不影响数据。

---

## 4. 常用命令

`deploy/docker-onekey.js` 提供以下子命令：

```bash
node deploy/docker-onekey.js --logs       # 查看实时日志（Ctrl+C 退出，不影响运行）
node deploy/docker-onekey.js --stop       # 停止并删除容器（数据卷保留）
node deploy/docker-onekey.js              # 启动 / 重新启动
node deploy/docker-onekey.js --port 8080  # 指定宿主机端口
```

等效的原生命令：

```bash
docker compose up -d --build    # 启动
docker compose logs -f          # 日志
docker compose ps               # 状态（healthy 表示健康检查通过）
docker compose down             # 停止（数据卷保留）
docker restart lczoj            # 重启容器
```

---

## 5. 更新到新版本

数据卷不受更新影响，三种方式任选其一：

```bash
# ① 在宿主机项目目录执行（重新构建镜像并重建容器）
node deploy/update.js --docker

# ② 重新执行 Docker 一行部署脚本（自动拉取新代码并重建）
#    GitHub 源：
curl -fsSL https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/docker-bootstrap.sh | sudo bash
#    Gitee 源：
curl -fsSL https://gitee.com/lichenzhen0713/LCZOJ/raw/master/docker-bootstrap.sh | sudo bash

# ③ 手动拉取代码后重建
git pull && docker compose up -d --build
```

镜像标签为 `lczoj:<版本号>`（例如 `lczoj:2.0.2`），旧标签保留在本机可用于回滚：

```bash
docker images lczoj
docker rm -f lczoj
docker run -d --name lczoj --restart unless-stopped -p 80:80 \
  -v lczoj-data:/app/data lczoj:2.1.0
```

> **容器内无法更新**：容器里的 `/app` 来自镜像、属主为 `root`，而服务以普通用户 `node` 运行，
> 因此管理后台的「版本更新」在容器里会失败（典型报错 `EACCES: permission denied, open '/app/.dockerignore'`）。
> 后台检测到容器环境后会**显示宿主机更新命令并禁用「立即更新」按钮**；请在宿主机执行：
>
> ```bash
> node deploy/docker-onekey.js --rebuild        # 推荐：拉取新代码并重建容器
> docker compose up -d --build                  # 或使用 compose
> docker compose pull && docker compose up -d   # 仅拉取新镜像时
> ```
>
> 数据卷 `lczoj-data` 不受影响。完整的更新说明见 [UPDATE.md](UPDATE.md) 第 5 节。

---

## 6. 备份与恢复

```bash
# 备份：将数据卷打包到当前目录
docker run --rm -v lczoj-data:/data -v "$PWD:/backup" alpine tar czf /backup/lczoj-data.tar.gz -C /data .

# 恢复：清空数据卷后解包
docker run --rm -v lczoj-data:/data -v "$PWD:/backup" alpine sh -c "rm -rf /data/* && tar xzf /backup/lczoj-data.tar.gz -C /data"
```

如需直接以文件形式管理数据（便于用文件管理器备份），将 `docker-compose.yml` 中的 `lczoj-data:/app/data` 改为 `./data:/app/data`。容器入口脚本会把该目录属主改为容器内的 `node` 用户（UID 1000），因此宿主机上目录属主显示为 `1000:1000` 属正常现象。

---

## 7. 绑定域名与 HTTPS

容器仅提供 HTTP 服务，域名与证书交由宿主机的 Nginx（或面板站点）处理：

```nginx
server {
    listen 80;
    server_name oj.example.com;

    client_max_body_size 64m;            # 缺少此项时上传较大答案包会返回 413

    location / {
        proxy_pass http://127.0.0.1:80;  # 对应 compose 中的端口映射（使用 8080 时改为 8080）
        proxy_http_version 1.1;
        proxy_read_timeout 300s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

证书可使用面板的「SSL → Let's Encrypt」申请，或执行 `certbot --nginx -d oj.example.com`。

---

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示未检测到 docker | Docker 未安装或终端未重启；Windows / macOS 需确认 Docker Desktop 已启动 |
| 浏览器无法访问 | ① `node deploy/docker-onekey.js --logs` 查看报错；② 云服务器安全组或防火墙放行对应端口 |
| 提示端口被占用 | 更换端口：`node deploy/docker-onekey.js --port 8080`，或修改 compose 中的端口映射 |
| 首次启动耗时较长 | 属正常现象，需下载镜像并安装 C++ / Java / Go 等编译器 |
| 上传答案压缩包报「请求体过大」 | 前置 Nginx 需配置 `client_max_body_size 64m;` |
| 判题缓慢或宿主机负载高 | 调低 `docker-compose.yml` 中的 `OJ_MAX_JUDGES`，或为容器设置 CPU 限制 |
| 需要重新部署 | `node deploy/docker-onekey.js --stop` 后再次执行 `node deploy/docker-onekey.js`，数据不会丢失 |
| 需要彻底清空数据 | `docker volume rm lczoj-data`（不可恢复）；也可用上述备份命令先备份 |

---

## 9. 镜像内容

| 语言 | 来源 |
| --- | --- |
| Python 3、JavaScript | 基础镜像自带 |
| C++ 14 / 11 / 98、C 11 | Debian `build-essential`（GCC 12），默认静态编译 |
| Java | Debian `default-jdk-headless`（JDK 17） |
| PHP 8 | Debian `php-cli` |
| Pascal | Debian `fp-compiler`（Free Pascal 3.2.2） |
| Go | 官方 `golang:1.23` 镜像（判题要求 ≥ 1.21） |
| Rust | Debian `rustc` |

如需精简镜像（仅保留 Python / JavaScript / PHP）：

```bash
docker build --build-arg WITH_TOOLCHAINS=0 -t lczoj:slim .
```

镜像内置健康检查（探测 `/api/health`），`docker compose ps` 显示 `healthy` 表示运行正常；容器内以非 root 用户运行，收到停止信号时会先等待正在进行的评测结束后再退出。

> **安全提示**：判题会执行用户提交的代码。容器仅提供环境隔离，并非安全沙箱。建议：① 不使用 `--privileged`；② 不挂载宿主机敏感目录；③ 尽量部署在独立机器或虚拟机上。

---

## 10. 其它部署方式

- 宝塔面板 / 小皮面板：[PANEL.md](PANEL.md)
- 普通 Linux（一键脚本 / systemd）：[DEPLOYMENT.md](DEPLOYMENT.md)
- 版本更新（含 Docker 回滚）：[UPDATE.md](UPDATE.md)
- 环境自检：`node deploy/check-env.js`
