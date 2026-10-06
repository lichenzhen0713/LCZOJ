# 版本更新指南

本文说明 LCZOJ 的版本更新（升级）方式：更新内容、四种更新途径的具体操作步骤、按部署方式对应的重启命令、更新后的确认项、回滚方法与常见问题。

> **管理后台更新入口**：登录 `admin` 账号 → 系统设置（`#/settings`） → **版本更新**，可在网页上完成「检查更新 / 一键更新」。

---

## 1. 更新影响范围

| 项目 | 是否受影响 | 说明 |
| --- | --- | --- |
| 程序代码（`server.js`、`src/`、`public/`、`docs/`、`deploy/`、`Dockerfile` 等） | **会被覆盖** | 更新即用新版本文件替换旧版本文件 |
| 数据库 `data/oj.db` | 不受影响 | 表结构由程序启动时的迁移逻辑自动升级，无需手工处理 |
| 题库测试数据 `data/testdata/`、题目附件 `data/attachments/`、用户头像 `data/avatars/` | 不受影响 | 更新脚本显式跳过整个 `data/` 目录 |
| 本地配置 `deploy/panel.env` | 不受影响 | 更新脚本显式跳过该文件 |
| 日志 `logs/`、版本库元数据 `.git/`、`node_modules/` | 不受影响 | 同样在跳过列表中 |
| Docker 数据卷 `lczoj-data` | 不受影响 | 重建容器不会删除数据卷 |

更新前的备份：更新脚本会先把 `data/oj.db` 复制到 `data/backup/oj-<旧版本>-<时间>.db`（最多保留最近 10 份）；`data/` 下的题库数据、附件、头像在此次更新中没有变动，无需额外备份。

---

## 2. 四种更新方式对照

| 方式 | 适用场景 | 入口 | 是否自动重启 |
| --- | --- | --- | --- |
| **管理后台一键更新** | 管理员希望全程在网页上完成 | 系统设置（`#/settings`） → 版本更新 | 是 |
| **命令行一键更新** | 有服务器终端权限，需要脚本化/无人值守 | `node deploy/update.js` | 是 |
| **Docker 更新** | 使用 Docker / Compose 部署 | `node deploy/update.js --docker` 或重新构建镜像 | 是 |
| **手动更新** | 服务器无法访问外网，或需要精确控制每一步 | 手工下载并覆盖代码 | 否（手动重启） |

四种方式最终效果一致：**用新版本的程序文件替换旧文件，然后重启服务**。

---

## 3. 方式一：管理后台一键更新（推荐）

### 3.1 前置条件

- 使用最高管理员账号 `admin` 登录（其他管理员即使拥有「系统设置」权限也无法看到该功能）；
- 服务器能够访问 **Gitee**（默认更新源，`https://gitee.com/lichenzhen0713/LCZOJ`）；Gitee 不可达时会自动回退 GitHub；
- 如需使用自建仓库或内网镜像，可通过环境变量指定（支持多个地址，按顺序尝试，用英文逗号分隔）：

  | 环境变量 | 用途 | 默认值 |
  | --- | --- | --- |
  | `OJ_UPDATE_URL` | 版本号检查地址（返回 `package.json` 的 JSON） | Gitee（默认）：`https://gitee.com/lichenzhen0713/LCZOJ/raw/master/package.json`；GitHub（备用）：`https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/package.json` |
  | `OJ_UPDATE_ZIP_URL` | 源码包下载地址（zip） | Gitee（默认）：`https://gitee.com/lichenzhen0713/LCZOJ/repository/archive/master.zip`；GitHub（备用）：`https://github.com/lichenzhen0713/LCZOJ/archive/refs/heads/master.zip` |

  这两个变量在启动服务前设置（面板部署写入 `deploy/panel.env`，systemd 写入 `Environment=`，Docker 写入 compose 的 `environment`）。

  **自建镜像源的硬要求：地址必须直接返回 zip 文件。** Gitee 的归档地址（`…/repository/archive/master.zip`）对**浏览器 UA 或自定义 UA**（如 `undici`、`LCZOJ/…`、`Mozilla/…`）会返回 **HTTP 200 + 一张「该操作需登录 Gitee 帐号」的 HTML 页面**，只有不带 UA（Node 默认 `node`）或 curl / wget 这类短标识 UA 才真正返回 zip。程序会**按 ZIP 魔数判断响应内容**：不是 zip 就换一个 UA 重试，仍不行则**自动换下一个源**（默认即回退 GitHub），所以登录页不会被当成更新包写入；但自建源若只回一个网页（或登录跳转页），更新会失败并提示「该地址没有返回源码包」。配置了 `OJ_UPDATE_SHA256` 时同理：**网页响应会先被判为「不是源码包」**，而不是误报「哈希不匹配」；只有确认拿到 zip 之后哈希不符，才提示「源码包完整性校验失败」。

### 3.2 操作步骤

1. 登录后台 → **系统设置（`#/settings`）**，页面顶部显示当前版本号；
2. 在「**版本更新**」区块中查看当前版本与官方最新版本（区块内会同时显示服务的启动方式，例如 PM2、systemd 或面板脚本后台进程）；
3. 需要时点击「**重新检查**」重新获取最新版本号；
4. 勾选「更新前备份数据库」（默认勾选），点击「**立即更新到 vX.Y.Z**」，在确认框中确认；
5. 页面显示实时进度日志，阶段依次为：检查最新版本 → 备份数据库 → 下载新版本代码 → 覆盖代码文件 → 重启服务；
6. 进入「重启服务」阶段后页面提示「服务正在重启，N 秒后自动刷新」，倒计时结束后自动刷新，刷新后版本号应变为新版本。

### 3.3 更新源与更新包校验

**更新源**：默认 **Gitee 优先**，失败自动回退 GitHub；每个源的连接超时为 8 秒。检查结果中会记录本次实际使用的来源（Gitee / GitHub / 自定义源）以及每个源的尝试结果，界面与接口都会展示，便于定位网络或仓库问题。

**更新包校验**：源码包在写入前会做整体校验，任一项不通过即**中止更新且不修改任何文件**：

| 校验项 | 说明 |
| --- | --- |
| 响应是不是 ZIP | 必须是 zip 源码包；HTTP 200 的网页 / 登录页 / 反爬页一律判为下载失败，换 UA 重试后换下一个源（见 3.1） |
| 合并冲突标记 | 代码与文本文件中不得残留 `<<<<<<<` / `=======` / `>>>>>>>`（仓库未正确合并时最常见） |
| `package.json` | 必须是合法 JSON（否则版本号无法读取） |
| `server.js` | 必须通过语法检查（`vm` 编译，不执行） |

校验失败时，界面与命令行都会给出具体文件与原因；数据库备份已完成、程序文件保持原状，修复仓库后重新执行更新即可。
版本检查阶段若源返回内容不是合法 JSON，会尽力从文本中解析版本号，并在界面提示「源内容格式异常」，提示管理员检查仓库文件。

**写权限预检（含只读部署 EROFS）**：覆盖代码前会先做写权限预检，位置在**下载源码包之前**——不可写时立刻给出可操作指引并结束本次更新，不会「下载完、备份完才失败」。Linux 上 systemd 加固（`ProtectSystem=strict`，或 `ReadOnlyPaths`；LCZOJ 自带的 `deploy/lczoj.service` 就是这种配置）会把项目目录挂成**只读**，典型报错是 `EROFS: read-only file system`，此时**改属主（chown）无效**：

| 情况 | 典型表现 | 正确做法 |
| --- | --- | --- |
| 只读挂载（EROFS） | 预检提示「项目目录挂成了只读（EROFS）」 | 在**服务器终端**（不在单元的只读命名空间内）执行 `sudo node deploy/update.js`，完成后 `sudo systemctl restart lczoj`。依赖 `OJ_UPDATE_*` 环境变量时用 `sudo -E node deploy/update.js`（`sudo` 默认会清空环境变量） |
| 属主 / 权限不足（EACCES、EPERM） | 预检提示「无写入权限」，或 `ls -ld <项目目录>` 的属主与服务运行用户不一致 | `chown -R <运行用户>:<运行用户> <项目目录>`（面板部署常见 `www`），或以 sudo 运行服务 |

若确实需要**网页端自助更新**（默认不开启）：把项目目录也加进单元的 `ReadWritePaths`，例如
`ReadWritePaths=/www/wwwroot/lczoj/data /www/wwwroot/lczoj/logs /tmp /www/wwwroot/lczoj`，然后 `sudo systemctl daemon-reload && sudo systemctl restart lczoj`。
**安全取舍**：这样一来服务运行账户也能改写站点代码，`ProtectSystem=strict` 的加固被削弱——服务一旦被攻陷，攻击者可**持久化篡改站点代码**；因此默认不放开，仍推荐「网页端只检查更新，更新放到宿主机用命令行执行」。

### 3.4 说明与限制

- **Docker 部署不能在容器内更新**：检测到容器环境时，更新卡片会显示宿主机更新命令并**禁用「立即更新」按钮**（原因与命令见第 5 节）；
- 更新只覆盖**程序代码**：数据库、题库测试数据、附件、头像与本地配置（`deploy/panel.env`）均不受影响；
- 更新包会先做**预检**（`package.json` 是否合法 JSON、`server.js` 能否通过语法检查、文本文件是否含合并冲突标记），不通过则**不覆盖任何文件**；
- 覆盖前会做**写权限预检**（在**下载源码包之前**）：不可写时直接给出可操作指引并结束本次更新，不会写到一半留下半新半旧的代码；万一写入过程中仍有文件失败（例如被占用），**已写入的文件会被回滚**。只读挂载（EROFS）与属主权限不足（EACCES）的处理方式不同，见 3.3 与第 9 节；
- 更新过程中网站不可用约 5~20 秒（取决于重启速度）；
- 若当前版本已是最新，界面只显示「已是最新版本」；如需强制重新拉取代码，可点击「**强制重新拉取代码**」；
- 更新失败时区块内显示错误信息与完整日志，可按第 9 节排查；若已发生部分覆盖，建议按第 8 节回滚后再重试。

---

## 4. 方式二：命令行一键更新

在项目目录执行：

```bash
node deploy/update.js             # 检查 + 更新 + 重启（更新前自动备份数据库）
node deploy/update.js --check     # 只检查有没有新版本，不做任何修改
node deploy/update.js --yes       # 不询问，直接更新（适合脚本化）
node deploy/update.js --no-backup # 跳过数据库备份
node deploy/update.js --no-restart# 只更新代码，不自动重启
node deploy/update.js --force     # 已是最新版本时也强制重新拉取代码
node deploy/update.js --docker    # Docker 部署：重新构建镜像 + 重建容器
```

执行流程：

1. **检查最新版本**：依次请求 GitHub、Gitee（或 `OJ_UPDATE_URL` 指定的地址），比较版本号；已是最新且未加 `--force` 时直接结束；
2. **备份数据库**：复制 `data/oj.db` 到 `data/backup/`；
3. **更新代码**：项目是 git 仓库时执行 `git pull --ff-only`；否则下载官方源码包并只覆盖代码文件（跳过 `data/`、`logs/`、`.git/`、`node_modules/`、`deploy/panel.env`）；
4. **重启服务**：按检测到的启动方式执行重启（见下一节）。

命令行输出以 `[信息] / [注意] / [完成]` 标注，并列出更新前后的版本号。

### 4.1 重启行为对照

| 检测到的启动方式 | 判断依据 | 重启动作 |
| --- | --- | --- |
| PM2 | 存在名为 `lczoj` 的应用，且该应用进程号与当前进程一致 | `pm2 restart lczoj --update-env` |
| systemd（有自动重启策略） | 存在 `lczoj.service`、处于激活状态、单元主进程号与当前进程一致，且 `Restart=always / on-failure` 等 | 程序直接退出，由 systemd 自动拉起（**不需要 root 权限**） |
| systemd（无自动重启策略） | 同上但 `Restart=no` | `systemctl restart lczoj`；非 root 时自动回退 `sudo -n systemctl restart lczoj`，均失败则提示手动执行 |
| 面板脚本后台进程 | 存在 `deploy/panel.pid` | 由 `deploy/restart-helper.js` 等待旧进程退出后，用相同参数在后台拉起新进程，并更新 `deploy/panel.pid` |
| 直接运行（无守护） | 以上均不满足 | 同上，由重启助手拉起新进程（日志追加到 `logs/lczoj.log`） |

> 判定会核对进程号：如果只是**存在**同名 PM2 应用或 `lczoj.service` 单元，但当前进程并非由它们启动（例如手工执行过 `node server.js`），则不会交给它们重启，避免出现两个实例争抢端口。

**无需任何权限的自动重启（推荐）**：若 systemd 单元配置了 `Restart=always`（`on-failure` 等亦可），更新完成后程序会直接退出，由 systemd 自动拉起新进程 —— 这是系统内置部署脚本的默认配置，因此 Linux 一键脚本 / 手动 systemd 部署通常都能自动重启，无需 sudo。

### 4.2 systemd 部署：重启权限

systemd 托管的服务通常以普通用户（如 `www`）运行，该用户默认无权执行 `systemctl restart`。更新流程按以下顺序处理：

1. **单元配置了自动重启时（推荐，默认即如此）**：`deploy/lczoj.service` 与安装脚本生成的单元均为 `Restart=always`，此时**无需任何权限**——更新完成后程序直接退出，由 systemd 自动拉起新进程（`Restart=on-failure` 等策略同样适用，程序会以非 0 退出码结束以确保被拉起）。界面会显示「服务正在重启」并自动刷新页面。
2. 否则先直接执行 `systemctl restart lczoj`；
3. 失败则尝试免密 sudo：`sudo -n systemctl restart lczoj`（`-n` 表示不询问密码，无权限时立即失败，不会卡住）；
4. 以上都不可行时**不再判定为更新失败**：程序代码此时已经更新完成，界面会提示「代码已更新完成，请手动执行：`sudo systemctl restart lczoj`」，并在日志中给出具体失败原因。

**检查与配置**：

```bash
# 查看单元是否配置了自动重启（always / on-failure 均可）
systemctl show -p Restart --value lczoj

# 若为 no，可在单元中加上 Restart=always 后重载（推荐，之后更新会自动重启）
sudo sed -i 's/^Restart=.*/Restart=always/' /etc/systemd/system/lczoj.service
sudo systemctl daemon-reload && sudo systemctl restart lczoj

# 或者授予最小权限的重启 sudo 规则（同样只需执行一次）
sudo bash deploy/grant-restart-permission.sh
sudo bash deploy/grant-restart-permission.sh --user www   # 手动指定服务运行用户
sudo bash deploy/grant-restart-permission.sh --remove     # 撤销
```

`grant-restart-permission.sh` 写入 `/etc/sudoers.d/lczoj-restart`，仅授予运行用户对**本服务**的 `restart / start / stop / is-active` 权限（其它 systemctl 操作仍不允许），并用 `visudo -cf` 校验语法，校验不通过会自动回滚。

---

## 5. 方式三：Docker 部署更新

> **最简单的更新方式（推荐，一条命令）**：在**宿主机**上进入本项目目录，执行
>
>     node deploy/docker-onekey.js --rebuild
>
> 自动拉取新版本源码 → 重新构建镜像 → 重建并重启容器，**数据卷不受影响**。
>
> 若你用的是镜像仓库里的镜像，也可只换一行：`docker compose pull && docker compose up -d`（无需手工算哈希或导入镜像包）。


> **注意：Docker 部署不使用管理后台的「一键更新」。** 容器内的 `/app` 是镜像的一部分、属主为 `root`，而服务以普通用户 `node` 运行，
> 容器内没有写入权限（典型报错：`EACCES: permission denied, open '/app/.dockerignore'`）；即便写入成功，
> 容器重建后也会回到镜像内的版本。因此后台更新卡片在检测到容器环境时会**直接给出宿主机命令并禁用更新按钮**，
> 更新统一在**宿主机**上执行（数据卷 `lczoj-data` 均不受影响）。

三种做法任选其一：

```bash
# ① 在宿主机项目目录执行（重新构建镜像并重建容器，推荐）
node deploy/docker-onekey.js --rebuild
# 或等价的脚本入口：
node deploy/update.js --docker

# ② 重新执行一次 Docker 一行部署脚本（自动拉取新代码并重建）
#    GitHub 源：
curl -fsSL https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/docker-bootstrap.sh | sudo bash
#    Gitee 源：
curl -fsSL https://gitee.com/lichenzhen0713/LCZOJ/raw/master/docker-bootstrap.sh | sudo bash

# ③ 手动拉取代码后重建
git pull
docker compose up -d --build
```

镜像标签为 `lczoj:<版本号>`（例如 `lczoj:2.8.9`），旧标签会保留在本机，可用于回滚：

```bash
# 查看本机已有镜像
docker images lczoj

# 用旧版本镜像重新启动容器（数据卷不变）
docker rm -f lczoj
docker run -d --name lczoj --restart unless-stopped -p 80:80 \
  -v lczoj-data:/app/data lczoj:2.1.0
```

更新完成后确认：`docker compose ps` 显示 `healthy`；版本号看系统设置页（`#/settings`）或容器启动日志（`/api/health` 出于安全只返回运行状态）。

若确实需要在容器内覆盖代码（例如临时补丁、无外网重建镜像），可显式放开该限制——但请自行承担容器重建后改动丢失的风险：

```bash
# 方式：进入容器后以 root 覆盖代码（不推荐，仅应急）
docker exec -it -u 0 lczoj sh
```

---

## 6. 方式四：手动更新（不依赖脚本）

适用于服务器无法访问外网，或希望精确控制每一步的场景。

1. **停止服务**（按部署方式选择对应命令，见第 7 节）；
2. **备份数据目录**：

   ```bash
   cp -r data ~/lczoj-data-backup-$(date +%Y%m%d)
   ```

3. **取得新版本程序文件**：在能上网的机器上下载项目压缩包，上传到服务器；
4. **覆盖程序文件**：把新版本文件复制到项目目录，**保留以下内容**：
   `data/`、`logs/`、`deploy/panel.env`、`.git/`（若使用 git 管理）；
5. **启动服务**；
6. **确认版本**：打开系统设置（`#/settings`）查看版本号是否为新版本（`/api/health` 出于安全只返回 `status`，不含版本号）；必要时对照 `package.json` 与启动日志。

使用 git 管理代码时，推荐：

```bash
git fetch --all
git checkout .          # 放弃本地对程序文件的修改（data/ 已在 .gitignore 中，不受影响）
git pull --ff-only
```

---

## 7. 各部署方式的重启命令

| 部署方式 | 重启命令 |
| --- | --- |
| systemd | `sudo systemctl restart lczoj` |
| PM2 | `pm2 restart lczoj --update-env` |
| 宝塔 / 小皮面板（Node 项目托管） | 面板内对应项目点击「重启」 |
| 面板一键脚本（后台进程） | `node deploy/panel-install.js --stop && node deploy/panel-install.js --start` |
| Docker Compose | `docker compose restart`（代码更新需 `docker compose up -d --build`） |
| Docker（不用 compose） | `docker restart lczoj` |
| 直接运行（前台） | `Ctrl+C` 后重新执行 `node server.js` |
| Windows（前台） | 关闭窗口后重新执行 `node server.js` |

---

## 8. 更新后的确认清单

1. 系统设置（`#/settings`）与启动日志显示的版本为新版本号；
2. 系统设置（`#/settings`） 的版本号、`package.json` 的 `version`、启动日志中的版本号三处一致；
3. 浏览器强制刷新（`Ctrl+F5`）后页面正常：题库可打开、题面公式正常、提交代码可评测；
4. 提交记录与题库数据完整（更新不影响数据）；判题队列中若原有一次提交被打断，重新提交即可，超级管理员也可对题目执行重判；
5. 服务器无异常日志：`journalctl -u lczoj -f`（systemd）或 `pm2 logs lczoj`（PM2）或 `logs/lczoj.log`（面板脚本）。

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 更新后页面仍是旧版本 | 浏览器缓存。强制刷新（`Ctrl+F5`）或清理站点缓存；再确认服务已按新版本重启（`/api/health` 出于安全只回 `status`，版本号看系统设置页或 `logs/lczoj.log` 的启动横幅） |
| 点击「重新检查」后提示无法获取版本信息 | 界面会列出每个更新源的失败原因（HTTP 状态、连接超时、内容中未找到 version 字段等）。检查服务器到 Gitee 的网络，或用 `OJ_UPDATE_URL` 指定可用镜像 |
| 提示「更新源返回的内容不是合法 JSON」 | 仓库中的 `package.json` 未同步完整或存在合并冲突标记。版本号是尽力解析的结果，请先修复仓库文件 |
| 提示「源码包校验未通过，已中止更新」 | 下载到的源码包含合并冲突标记、`package.json` 非 JSON 或 `server.js` 语法错误。此时**未修改任何文件**，请在代码仓库中修复后重新更新 |
| 提示「代码已更新完成，请手动执行 `sudo systemctl restart lczoj`」 | 服务由 systemd 托管而当前进程没有重启权限。按提示执行该命令即可生效；如需今后自动重启，执行一次 `sudo bash deploy/grant-restart-permission.sh` |
| 提示「无法下载源码包」 | 服务器无法访问 Gitee 与 GitHub。可设置 `OJ_UPDATE_ZIP_URL` 指向内网镜像，或采用方式四手动更新 |
| 更新时页面 502 / 连接中断 | 重启期间属正常现象，等待 5~20 秒后刷新即可；若长时间未恢复，检查进程与日志 |
| 点击更新提示「仅最高管理员可操作」 | 该功能限定内置 `admin` 账号，其他管理员不可用 |
| 提示「已有更新任务正在进行中」 | 上一次更新尚未结束，等待其完成后重试；如确认已中断，可重启服务后重试 |
| 更新后题库或提交记录缺失 | 数据位于 `data/`，请确认启动时的工作目录与 `OJ_DATA_DIR` 未改变；必要时从 `data/backup/` 恢复数据库后重启 |
| 更新后无法启动 | 查看日志中的报错（常见为 Node 版本过低、依赖缺失、端口占用）；可从备份压缩包恢复程序文件，或按第 10 节回滚 |
| Docker 更新后版本回到旧版 | 容器被重建，读的是镜像内的代码。请用 `node deploy/docker-onekey.js --rebuild`（或 `docker compose up -d --build`）在宿主机更新，或改用方式三 |
| 更新失败：`EACCES: permission denied, open '/app/.dockerignore'` | 在 **Docker 容器内**触发了更新。容器里的 `/app` 属主是 `root`、服务以普通用户 `node` 运行，因此没有写入权限（即使写成功，容器重建后也会被镜像覆盖）。请在**宿主机**执行 `node deploy/docker-onekey.js --rebuild` 或 `docker compose up -d --build`；后台更新卡片检测到容器环境时会直接给出这些命令并禁用按钮 |
| 更新失败：`EROFS: read-only file system` / 提示「项目目录挂成了只读（EROFS）」 | 项目目录所在文件系统是**只读**的：常见于 systemd 加固 `ProtectSystem=strict` / `ReadOnlyPaths`（LCZOJ 自带的 `deploy/lczoj.service` 即如此），**改属主（chown）无效**。后台「立即更新」会在**下载源码包之前**被写权限预检拦下并给出指引（不会半途失败）。请在**服务器终端**（不在单元只读命名空间内）执行 `sudo node deploy/update.js`，完成后 `sudo systemctl restart lczoj`；依赖 `OJ_UPDATE_*` 环境变量时用 `sudo -E node deploy/update.js`。若确实要网页端自助更新，见 3.3 的 `ReadWritePaths` 做法与安全取舍 |
| 更新失败：`EACCES` / `EPERM`（非 Docker） | 先区分两种原因（判断命令见本节末尾）：**只读挂载** → 按上一行用命令行更新；**权限不足**（属主与运行用户不一致）→ `chown -R <运行用户>:<运行用户> <项目目录>`（例如面板部署的 `www`），或用 sudo 运行服务。更新在覆盖前会先探测目标目录可写性，写入中途失败还会回滚已写入文件，因此通常**不会**留下部分覆盖的文件 |
| 更新失败：提示「该地址没有返回源码包」/「下载到的内容不是源码包 zip」 | 更新源返回了 HTTP 200，但内容是网页而不是 zip（最常见：Gitee 归档地址对浏览器 / 自定义 User-Agent 返回「该操作需登录 Gitee 帐号」的登录页）。程序会换 UA 重试并**自动回退下一个源**（默认 GitHub）；若所有源都如此，请把 `OJ_UPDATE_ZIP_URL` 指向**直接返回 zip** 的镜像，或采用方式四手动更新。注意：配置了 `OJ_UPDATE_SHA256` 时这种情况报的是「不是源码包」，**不会**误报「哈希不匹配」 |
| 命令行更新后提示「已发出重启指令，但 30 秒内未能在 …/api/health 检测到服务」 | 自动重启未成功。为保证新进程能绑定端口，命令行更新会结束**占着该端口的旧服务进程**（仅在确认它确实是本项目的 `node server.js` 时才结束）；若端口被其它进程占用则不会误杀，而是提示人工重启。排查见 `logs/lczoj.log`（重启助手的输出也在该文件），重启命令按第 7 节选择 |
| 需要回滚到旧版本 | 见下一节 |

**判断是「只读挂载」还是「权限不足」**（在服务器上执行）：

```bash
mount | grep ' / '                     # 看根分区挂载选项里有没有 ro（只读）
findmnt -no OPTIONS /                  # 等价写法：只输出挂载选项
touch <项目目录>/.__wtest && rm -f <项目目录>/.__wtest
                                       # 能建能删=可写；EROFS=只读挂载；EACCES/EPERM=权限不足
ls -ld <项目目录>                       # 属主是否为服务运行用户（如 lczoj / www）
```

---

## 10. 回滚方法

| 回滚对象 | 操作 |
| --- | --- |
| 程序代码（git 安装） | `git log --oneline` 找到目标版本，执行 `git checkout <commit>` 后重启服务 |
| 程序代码（压缩包安装） | 用旧版本压缩包按方式四覆盖程序文件（保留 `data/`）后重启 |
| 数据库 | 停止服务 → 从 `data/backup/` 选择对应时间的 `oj-<版本>-<时间>.db` 覆盖 `data/oj.db`（同时删除 `data/oj.db-wal`、`data/oj.db-shm`）→ 启动服务 |
| Docker | 用旧版本镜像标签重新启动容器（见第 5 节命令） |

> 数据库回滚会丢失备份时间点之后的提交与题目改动，仅在确有必要时使用。

---

## 11. 相关文件与接口

| 名称 | 说明 |
| --- | --- |
| `src/version.js` | 版本号比较与最新版本查询（成功缓存 6 小时，失败缓存 10 分钟，连不上时静默降级） |
| `src/updater.js` | 更新引擎：备份、下载、覆盖代码、重启（命令行与后台共用） |
| `deploy/update.js` | 命令行更新入口 |
| `deploy/restart-helper.js` | 无进程守护时负责拉起新进程 |
| `deploy/grant-restart-permission.sh` | （Linux / systemd）为服务运行用户配置最小权限的重启 sudo 规则 |
| `GET /api/version` | 查询当前版本与最新版本（需登录） |
| `GET /api/admin/update` | 查询版本信息、更新状态与启动方式（仅 admin） |
| `GET /api/admin/update/status` | 查询更新进度与日志（仅 admin） |
| `POST /api/admin/update/start` | 开始更新，参数 `{ backup, restart, force }`（仅 admin） |
