'use strict';
/**
 * 版本与更新检查
 *
 * 数据来源（默认 **Gitee 优先**，失败自动回退 GitHub）：
 *   https://gitee.com/lichenzhen0713/LCZOJ/raw/master/package.json
 *   https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/package.json
 *
 * 可用环境变量 OJ_UPDATE_URL 覆盖（多个地址用英文逗号分隔，按顺序尝试）：
 *   OJ_UPDATE_URL=https://example.com/lczoj/package.json
 *
 * 行为说明：
 *   · 成功结果缓存 6 小时，失败结果缓存 10 分钟；`force` 可绕过缓存重新检查；
 *   · 源返回内容不是合法 JSON 时（例如仓库文件未同步完整、存在合并冲突标记），
 *     会尽力从文本中解析出版本号，并在结果里带 `warn` 字段提示管理员；
 *   · 所有源都不可用时返回 `error` 与 `tried`（每个源的具体原因），不抛异常，不影响站点运行。
 */

const CURRENT = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

/** 默认更新源：Gitee 优先（国内网络可达性更好），GitHub 作为备用 */
const DEFAULT_SOURCES = [
  { label: 'Gitee（默认）', url: 'https://gitee.com/lichenzhen0713/LCZOJ/raw/master/package.json' },
  { label: 'GitHub（备用）', url: 'https://raw.githubusercontent.com/lichenzhen0713/LCZOJ/master/package.json' },
];

const OK_TTL = 6 * 60 * 60 * 1000;   // 成功结果缓存 6 小时
const FAIL_TTL = 10 * 60 * 1000;     // 失败结果缓存 10 分钟

let cache = { at: 0, ok: false, data: null };

/** 实际使用的更新源列表（自定义源优先） */
function sources() {
  const custom = String(process.env.OJ_UPDATE_URL || '')
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (custom.length) return custom.map((url) => ({ label: '自定义源', url }));
  return DEFAULT_SOURCES;
}

/** 比较版本号：a > b 返回 1，相等 0，小于 -1（支持 v 前缀与 -beta 后缀） */
function compareVersion(a, b) {
  const pick = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = pick(a);
  const B = pick(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 从源内容里解析版本号：先按严格 JSON，失败再按文本宽松匹配（兼容冲突标记等格式问题） */
function parseVersion(text) {
  const raw = String(text || '');
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.version === 'string' && obj.version.trim()) {
      return { version: obj.version.trim(), lenient: false };
    }
  } catch { /* 继续尝试宽松解析 */ }
  const m = raw.match(/"version"\s*:\s*"([0-9][^"]*)"/);
  if (m) return { version: m[1].trim(), lenient: true };
  return null;
}

/**
 * 查询最新版本。
 * @param {{force?: boolean, timeoutMs?: number}} opts
 * @returns {Promise<{current:string,latest:string,has_update:boolean,source?:string,source_label?:string,
 *                    checked_at:number,warn?:string,error?:string,tried:Array<{label:string,url:string,ok:boolean,error?:string}>}>}
 */
async function checkLatest(opts = {}) {
  const now = Date.now();
  const ttl = cache.ok ? OK_TTL : FAIL_TTL;
  if (!opts.force && cache.data && now - cache.at < ttl) return cache.data;

  const timeoutMs = opts.timeoutMs || 8000;
  const list = sources();
  const tried = [];

  for (const src of list) {
    const started = Date.now();
    try {
      const res = await fetch(src.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'LCZOJ/' + CURRENT, 'Cache-Control': 'no-cache' },
      });
      const text = await res.text();
      if (!res.ok) {
        tried.push({ label: src.label, url: src.url, ok: false, error: `HTTP ${res.status}` });
        continue;
      }
      const parsed = parseVersion(text);
      if (!parsed) {
        tried.push({ label: src.label, url: src.url, ok: false, error: '返回内容中未找到 version 字段' });
        continue;
      }
      tried.push({ label: src.label, url: src.url, ok: true, ms: Date.now() - started });
      const out = {
        current: CURRENT,
        latest: parsed.version,
        has_update: compareVersion(parsed.version, CURRENT) > 0,
        source: src.url,
        source_label: src.label,
        checked_at: Date.now(),
        tried,
      };
      if (parsed.lenient) {
        out.warn = '更新源返回的内容不是合法 JSON（可能是仓库文件未同步完整或存在合并冲突标记），已尽力从文本中解析出版本号。建议检查该仓库中的 package.json 是否完整。';
      }
      cache = { at: Date.now(), ok: true, data: out };
      return out;
    } catch (err) {
      const msg = (err && err.name === 'TimeoutError') ? `连接超时（${timeoutMs}ms）` : ((err && err.message) || String(err));
      tried.push({ label: src.label, url: src.url, ok: false, error: msg });
    }
  }

  const reasons = tried.map((t) => `${t.label}：${t.error}`).join('；');
  const out = {
    current: CURRENT,
    latest: '',
    has_update: false,
    checked_at: Date.now(),
    tried,
    error: `无法获取最新版本信息（已尝试 ${tried.length} 个更新源）——${reasons}`,
  };
  cache = { at: Date.now(), ok: false, data: out };
  return out;
}

module.exports = { CURRENT, checkLatest, compareVersion, parseVersion, sources };
