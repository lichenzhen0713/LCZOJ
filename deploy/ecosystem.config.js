/**
 * PM2 进程守护配置（宝塔面板 PM2 管理器 / 小皮面板 / 裸机都适用）
 *
 * 用法：
 *   npm install -g pm2                  # 安装 PM2（面板里通常已自带）
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save && pm2 startup            # 保存进程列表 + 开机自启（Linux）
 *
 * 面板里的等价操作：
 *   宝塔：软件商店 → PM2管理器 → 「添加项目」，项目目录选站点目录，
 *         启动文件选 server.js，端口填 3000，或直接让 PM2 加载本配置文件。
 *
 * 注意：instances 必须保持 1。SQLite 与判题队列都是单进程模型，
 *       多实例会导致判题重复、数据库写入冲突。
 */
module.exports = {
  apps: [
    {
      name: 'lczoj',
      script: 'server.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // 优雅退出：给正在评测的提交最多 20 秒收尾（server.js 里已处理 SIGTERM）
      kill_timeout: 20000,
      listen_timeout: 10000,
      // 日志：默认写在 ~/.pm2/logs/lczoj-*.log（宝塔 PM2 管理器 / `pm2 logs lczoj` 都能看）
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // 面板部署建议：Nginx 反代到本机 3000 端口，因此只监听 127.0.0.1
        PORT: '3000',
        OJ_HOST: '127.0.0.1',
        // 并行判题数（按服务器核数调整，留 1~2 核给系统）
        OJ_MAX_JUDGES: '4',
        TZ: 'Asia/Shanghai',
        // 数据目录：默认项目下的 data/，需要放到别处（如数据盘）时取消注释
        // OJ_DATA_DIR: '/www/wwwroot/lczoj-data',
      },
    },
  ],
};
