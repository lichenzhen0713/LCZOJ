'use strict';
/**
 * 部署脚本共用的网络 / 账号信息助手（零依赖）
 *
 *  · internalIp()          本机内网 IPv4 地址（公网识别失败时兜底）
 *  · publicIp()            识别服务器公网 IP（可用 LCZOJ_PUBLIC_IP 指定）
 *  · siteUrl(ip, port)     拼出 http://ip[:port]/ 
 *  · initialAdminPassword()首次初始化随机生成的管理员初始密码（数据目录里的 admin-password.txt）
 *
 * 说明：Docker / 面板等部署脚本必须给用户**公网地址**——内网 IP 只能在同一局域网访问，
 *       直接打印内网 IP 会让人以为网站打不开。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 查询公网 IP 的公开源（国内可达性优先，逐个尝试） */
const IP_SOURCES = [
  'https://ip.3322.net',
  'https://myip.ipip.net',
  'https://ifconfig.me/ip',
  'https://ipinfo.io/ip',
  'https://api.ipify.org',
  'https://ident.me',
  'https://4.ipw.cn',
];

/** 严格校验 IPv4：四段且每段 0~255、不允许前导零（避免把页面里的版本号等误当成 IP） */
function isValidIpv4(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && !/^0\d/.test(p) && Number(p) <= 255);
}

/**
 * 从响应文本中解析公网 IP：只接受较短（≤200 字符，排除 HTML 页面）的响应，
 * 并返回其中第一个**合法**的 IPv4 地址。
 */
function parseIp(text) {
  const body = String(text || '').trim();
  if (!body || body.length > 200) return '';
  for (const m of body.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})/g)) {
    if (isValidIpv4(m[1])) return m[1];
  }
  return '';
}


/** 本机内网 IPv4 地址 */
function internalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}

/**
 * 识别服务器公网 IP。
 * @returns {Promise<{ip:string, from:string}>} 识别失败时 ip 为空字符串
 */
async function publicIp() {
  const forced = String(process.env.LCZOJ_PUBLIC_IP || '').trim();
  if (isValidIpv4(forced)) return { ip: forced, from: 'LCZOJ_PUBLIC_IP' };
  for (const u of IP_SOURCES) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const ip = parseIp(await r.text());
      if (ip) return { ip, from: u.replace(/^https?:\/\//, '').split('/')[0] };
    } catch { /* 换下一个源 */ }
  }
  return { ip: '', from: '' };
}

/** 拼出访问地址（80 端口不带端口号） */
function siteUrl(ip, port) {
  return `http://${ip}${Number(port) === 80 ? '' : ':' + port}/`;
}

/** 数据目录（与 src/config.js 的规则一致） */
function dataDir() {
  return process.env.OJ_DATA_DIR ? path.resolve(ROOT, process.env.OJ_DATA_DIR) : path.join(ROOT, 'data');
}

/** 首次初始化随机生成的管理员初始密码（未初始化 / 文件已删除时返回空串） */
function initialAdminPassword(dir = dataDir()) {
  try {
    const t = fs.readFileSync(path.join(dir, 'admin-password.txt'), 'utf8');
    const m = t.match(/^初始密码：(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

module.exports = { internalIp, publicIp, siteUrl, initialAdminPassword, dataDir, IP_SOURCES, isValidIpv4, parseIp };
