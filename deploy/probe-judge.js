#!/usr/bin/env node
/**
 * LCZOJ 评估探查：直接在服务器上用 OJ 自己的评测模块跑一次提交
 * （与网页提交走同一套 judge.js，但绕开登录）
 *
 * 用法（在项目根目录，用 OJ 实际运行的用户执行）：
 *     node deploy/probe-judge.js 2          # 跑 #2（SPJ 测试题）
 *     node deploy/probe-judge.js 4          # 跑 #4（IO 交互测试题，猜数字）
 *     node deploy/probe-judge.js 4 --keep   # 保留下这次测试提交
 *
 * 它会打印：status / verdict / score / 耗时 / 编译错误 / 逐测试点判定与消息，
 * 以及 judge_detail 解压后的内容 —— 足以定位「通信题/SPJ 评测出问题」的确切原因。
 */
'use strict';
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const pid = parseInt(process.argv[2], 10);
const keep = process.argv.includes('--keep');
if (!pid) {
  console.log('用法: node deploy/probe-judge.js <题目ID> [--keep]  例如: node deploy/probe-judge.js 2');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(ROOT, process.env.OJ_DATA_DIR || 'data', 'oj.db'));
const judge = require(path.join(ROOT, 'src', 'judge.js'));

/* 内置两套"正确答案"，只对自带测试题 2 / 4 有效；其它题目请手动改 SOURCE */
const INNER = {
  2: '#include <bits/stdc++.h>\nint main(){ long long n; if(!(std::cin>>n)) return 0; std::cout<<n<<std::endl; return 0; }\n',
  4: '#include <bits/stdc++.h>\nint main(){ long long lo=1,hi=1000000000LL; while(lo<hi){ long long mid=(lo+hi)/2; std::cout<<"? "<<lo<<" "<<mid<<std::endl; std::string s; if(!(std::cin>>s)) return 0; if(s=="yes") hi=mid; else lo=mid+1; } std::cout<<"! "<<lo<<std::endl; return 0; }\n',
};

const prob = db.prepare('SELECT id,title,spj,problem_type,time_limit_ms FROM problems WHERE id=?').get(pid);
if (!prob) { console.log('✗ 题目 #' + pid + ' 不存在'); process.exit(1); }
console.log('  题目: #' + prob.id + ' ' + prob.title + ' | spj=' + prob.spj + ' | type=' + prob.problem_type + ' | 时限 ' + prob.time_limit_ms + 'ms');

const admin = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const src = INNER[pid] || '#include <bits/stdc++.h>\nint main(){ return 0; }\n';
const now = Date.now();
const info = db.prepare("INSERT INTO submissions (user_id, problem_id, language, code, status, verdict, created_at) VALUES (?, ?, 'cpp', ?, 'pending', 'Pending', ?)").run(admin ? admin.id : 1, pid, src, now);
const sid = Number(info.lastInsertRowid);
console.log('  测试提交: #' + sid + '（用户 ' + (admin ? admin.id : 1) + '）');

function decompress(v) {
  if (!v) return '';
  const s = String(v).trim();
  // judge_detail 可能是：zlib 字节数组的 JSON（多数字段）、逗号分隔字节串、或明文
  let bytes = null;
  try {
    const arr = s.startsWith('[') ? JSON.parse(s) : null;
    if (Array.isArray(arr)) bytes = Buffer.from(arr);
  } catch { bytes = null; }
  if (!bytes && /^\d+(,\d+)+$/.test(s)) {
    try { bytes = Buffer.from(s.split(',').map(Number)); } catch { bytes = null; }
  }
  if (bytes) {
    for (const fn of [zlib.inflateSync, zlib.gunzipSync, zlib.brotliDecompressSync]) {
      try { return fn(bytes).toString('utf8'); } catch { /* 换下一种 */ }
    }
  }
  return s;
}

(async () => {
  const t0 = Date.now();
  try { await judge.judgeSubmission(sid); }
  catch (e) { console.log('  ✗ judgeSubmission 抛异常: ' + e.message); console.log(String(e.stack || '').split('\n').slice(1, 6).join('\n')); }
  const row = db.prepare('SELECT * FROM submissions WHERE id=?').get(sid);
  console.log('\n  === 评测结果 ===');
  console.log('  status : ' + row.status);
  console.log('  verdict: ' + row.verdict);
  console.log('  score  : ' + row.score);
  console.log('  耗时/内存: ' + row.time_ms + 'ms / ' + row.memory_kb + 'KB');
  console.log('  墙钟耗时: ' + (Date.now() - t0) + 'ms');
  if (row.compile_error) {
    console.log('\n  === 编译错误 ===');
    console.log('  ' + String(row.compile_error).slice(0, 2000).replace(/\n/g, '\n  '));
  }
  const detail = decompress(row.judge_detail);
  if (detail) {
    console.log('\n  === judge_detail ===');
    let d = null;
    try { d = JSON.parse(detail); } catch { /* 纯文本 */ }
    if (d && Array.isArray(d.tests)) {
      for (const t of d.tests) {
        console.log('  #' + (t.id ?? t.index ?? '?') + '  ' + (t.verdict || t.status || '?') + '  ' + (t.time_ms ?? '') + 'ms  ' + String(t.message || t.checker_message || t.detail || '').slice(0, 300));
      }
    } else {
      console.log('  ' + detail.slice(0, 3000));
    }
  }
  if (!keep) {
    db.prepare('DELETE FROM submissions WHERE id=?').run(sid);
    console.log('\n  （已删除本次测试提交；加 --keep 可保留）');
  }
  db.close();
  process.exit(0);
})();
