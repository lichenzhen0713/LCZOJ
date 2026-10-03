# syntax=docker/dockerfile:1
# =============================================================================
#  LCZOJ 在线评测系统 · Docker 镜像
#  构建：docker build -t lczoj:2.0.9 .
#  运行：docker run -d --name lczoj -p 8080:80 -v lczoj-data:/app/data lczoj:2.0.9
#  说明：应用本身零外部依赖（不需要 npm install），镜像里预装的是**评测语言工具链**。
#       精简镜像（只保留 Python / JavaScript / PHP）：docker build --build-arg WITH_TOOLCHAINS=0 .
# =============================================================================

# ---------- 阶段 1：Go 工具链来源 ----------
# 直接取官方 Go 镜像里的完整安装目录（不必手写下下载地址，版本也跟随官方镜像）。
# 注意：判题侧写入的 go.mod 声明 `go 1.21`，镜像里的 Go 必须 ≥ 1.21（Debian bookworm 自带的 1.19 会拒绝编译）。
FROM golang:1.23-bookworm AS gotoolchain

# ---------- 阶段 2：运行镜像 ----------
FROM node:24-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
# WITH_TOOLCHAINS=0 → 精简镜像：不装 C/C++、Java、Pascal、Go、Rust（只留 Python / JavaScript / PHP）
ARG WITH_TOOLCHAINS=1

LABEL org.opencontainers.image.title="LCZOJ" \
      org.opencontainers.image.description="零依赖在线评测系统（Node.js 内置模块实现）" \
      org.opencontainers.image.version="2.0.9" \
      org.opencontainers.image.licenses="MIT"

# 站点运行参数：容器内默认监听 80，映射到宿主机用 -p 8080:80
ENV LANG=C.UTF-8 \
    TZ=Asia/Shanghai \
    PORT=80 \
    OJ_DATA_DIR=/app/data \
    NODE_ENV=production \
    GOTOOLCHAIN=local

# 基础工具 + 评测语言工具链
#   gosu / libcap2-bin：入口脚本用 gosu 降权到普通用户、setcap 允许非 root 绑定 80 端口
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl tzdata procps gosu libcap2-bin; \
    if [ "$WITH_TOOLCHAINS" = "1" ]; then \
      apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        default-jdk-headless \
        php-cli \
        fp-compiler \
        rustc; \
    else \
      apt-get install -y --no-install-recommends python3; \
    fi; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Go 工具链（放在与官方镜像一致的位置，GOROOT 保持 /usr/local/go）
COPY --from=gotoolchain /usr/local/go /usr/local/go
RUN if [ "$WITH_TOOLCHAINS" = "1" ]; then \
      ln -sf /usr/local/go/bin/go /usr/local/bin/go; \
    else \
      rm -rf /usr/local/go; \
    fi

# 允许非 root 用户绑定 80 端口（Docker 20.10+ 默认已把 ip_unprivileged_port_start 设为 0，这里再加一道保险）
RUN setcap 'cap_net_bind_service=+ep' "$(command -v node)" || true

WORKDIR /app

# 应用代码（零依赖，无需 npm install）
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY docs ./docs
COPY testlib ./testlib
COPY deploy ./deploy

# 数据目录（数据库 / 测试数据 / 附件 / 判题缓存）：运行时挂载出来持久化。
# 运行用户用镜像自带的 node 用户（UID/GID 1000，Debian 系 node 镜像默认就有，无需新建）。
# 同时把 .sh 行尾统一成 LF 并加可执行位，避免在 Windows 上编辑后出现 "not found"。
RUN mkdir -p /app/data \
    && sed -i 's/\r$//' /app/deploy/*.sh \
    && chmod +x /app/deploy/*.sh \
    && chown -R node:node /app/data /app/deploy

VOLUME ["/app/data"]
EXPOSE 80
STOPSIGNAL SIGTERM

# 健康检查：走站点自带的 /api/health（无需额外安装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
CMD ["node", "server.js"]
