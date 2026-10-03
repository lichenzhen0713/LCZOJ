'use strict';

const net = require('net');
const tls = require('tls');

/**
 * 极简 SMTP 客户端（零依赖，node:net / node:tls）。
 * 支持 smtp 465 (SSL) 与 587/25 (STARTTLS)。
 *
 * 关键修复：
 * 1) TLS 套接字不能用 unshift 回推数据（解密流不可回推，会丢数据导致 readLine 永久挂起），
 *    因此采用「单 data 监听 + 持久缓冲区 + 行队列」逐行消费响应；
 * 2) 465 隐式 TLS 须在读取 greeting 前用 tls.connect 包裹；
 * 3) 所有步骤均有超时（连接 20s、每次读行 20s），任何一步卡住都会快速失败而非无限挂起。
 */

function base64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** TCP 连接（带超时） */
function connectRaw(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      try { s.destroy(); } catch { /* ignore */ }
      reject(new Error('SMTP 连接超时'));
    }, timeoutMs || 20000);
    s.once('connect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 逐行读取器：累积缓冲区 + 行队列（供多个 await 顺序消费）。
 * 返回一个 read(timeoutMs) 函数：读不到一行时挂起等待，超时/关闭返回 null。
 */
function lineReader(sock) {
  let buf = Buffer.alloc(0);
  const lines = [];
  const waiters = [];
  let closed = false;

  function drain() {
    while (lines.length && waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.fn(lines.shift());
    }
    if (closed) {
      while (waiters.length) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.fn(null);
      }
    }
  }

  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).toString('utf8').replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    drain();
  });
  sock.on('close', () => { closed = true; drain(); });
  sock.on('error', () => { /* 由 close 兜底 */ });

  return function read(timeoutMs) {
    return new Promise((resolve) => {
      if (lines.length) return resolve(lines.shift());
      if (closed) return resolve(null);
      let done = false;
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        if (!done) { done = true; resolve(null); }
      }, timeoutMs || 20000);
      const w = {
        timer,
        fn(line) { if (done) return; done = true; resolve(line); },
      };
      waiters.push(w);
    });
  };
}

/** 发送一行命令并读取完整响应（多行响应合并到状态码行） */
function makeCmd(sock, read) {
  return async (line) => {
    sock.write(line + '\r\n');
    let code = '';
    let text = '';
    for (;;) {
      const resp = await read(20000);
      if (resp === null) return { code: 0, text: '（连接已关闭）' };
      // 去掉 TLS 分片时偶发的前缀空字节
      const clean = resp.replace(/^[\u0000-\u0009\u000B-\u001F\u007F]*/, '');
      code = clean.slice(0, 3);
      text += clean.slice(4) + ' ';
      if (clean.length < 4 || clean[3] === ' ') break;
    }
    return { code: parseInt(code, 10) || 0, text: text.trim() };
  };
}

function buildHeaders(cfg, user, msg) {
  const fromName = cfg.fromName || 'LCZOJ';
  return [
    `From: =?UTF-8?B?${Buffer.from(fromName, 'utf8').toString('base64')}?= <${user}>`,
    `To: <${msg.to}>`,
    `Subject: =?UTF-8?B?${Buffer.from(msg.subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
  ].join('\r\n');
}

/**
 * 发送一封邮件。
 * cfg: { host, port, secure, user, pass, fromName? }
 * msg: { to, subject, text, html }
 * 返回 { ok: true }；失败抛出 Error（含服务器返回信息）。
 */
async function sendMail(cfg, msg) {
  const host = String(cfg.host || '').trim();
  const port = parseInt(cfg.port || (cfg.secure ? '465' : '25'), 10);
  const user = String(cfg.user || '').trim();
  const pass = String(cfg.pass || '');
  if (!host || !user || !pass) throw new Error('SMTP 未配置');

  const raw = await connectRaw(host, port, 20000);
  const fail = (err) => { try { raw.destroy(); } catch { /* ignore */ } throw err; };

  try {
    const isSecure = cfg.secure == null ? port === 465 : (String(cfg.secure) === '1' || String(cfg.secure) === 'true' || cfg.secure === true);
    let sock = raw;
    if (isSecure) sock = tls.connect({ socket: raw, servername: host });
    let read = lineReader(sock);
    let cmd = makeCmd(sock, read);

    const greet = await read(20000);
    if (!greet || greet.slice(0, 3) !== '220') return fail(new Error('SMTP 连接失败: ' + (greet || '空响应')));

    let ehlo = await cmd('EHLO oj.local');
    if (ehlo.code !== 250) return fail(new Error('EHLO 失败: ' + ehlo.text));

    // 587/25：明文 → STARTTLS 升级为 TLS
    if (!isSecure) {
      const st = await cmd('STARTTLS');
      if (st.code === 220) {
        sock = tls.connect({ socket: raw, servername: host });
        read = lineReader(sock);
        cmd = makeCmd(sock, read);
        const stHello = await read(20000);
        if (!stHello || stHello.slice(0, 3) !== '220') return fail(new Error('STARTTLS 失败: ' + stHello));
        ehlo = await cmd('EHLO oj.local');
        if (ehlo.code !== 250) return fail(new Error('EHLO(TLS) 失败: ' + ehlo.text));
      }
    }

    const auth = await cmd('AUTH LOGIN');
    if (auth.code !== 334) return fail(new Error('AUTH 不被支持: ' + auth.text));
    await cmd(base64(user));
    const authPass = await cmd(base64(pass));
    if (authPass.code !== 235) return fail(new Error('SMTP 认证失败（用户名或授权码错误）: ' + authPass.text));

    const from = await cmd(`MAIL FROM:<${user}>`);
    if (from.code !== 250) return fail(new Error('MAIL FROM 失败: ' + from.text));
    const rcpt = await cmd(`RCPT TO:<${msg.to}>`);
    if (rcpt.code !== 250) return fail(new Error('RCPT TO 失败: ' + rcpt.text));

    const data = await cmd('DATA');
    if (data.code !== 354) return fail(new Error('DATA 失败: ' + data.text));

    const hdrs = buildHeaders(cfg, user, msg);
    const body = Buffer.from(msg.html || msg.text || '', 'utf8').toString('base64');
    sock.write(hdrs + '\r\n' + body + '\r\n.\r\n');
    const end = await read(20000);
    if (!end || end.slice(0, 3) !== '250') return fail(new Error('邮件发送失败: ' + (end || '空响应')));

    try { await cmd('QUIT'); } catch { /* ignore */ }
    raw.destroy();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

module.exports = { sendMail };
