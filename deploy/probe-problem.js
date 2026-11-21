#!/usr/bin/env node
/**
 * LCZOJ 题目资源自检：直接编译并试跑某道题的 checker / interactor / grader
 * （不需要选手代码，不产生提交记录）
 *
 * 用法（项目根目录）：
 *     node deploy/probe-problem.js 2        # 检查 SPJ 题的 checker
 *     node deploy/probe-problem.js 4        # 检查交互题的 interactor
 *
 * 它做四件事：
 *   1) 读题目行：spj / problem_type / meta.json（pipe_mode 等）
 *   2) 编译 checker.cpp（若有）→ 用 1.in / 1.out(当输出) / 1.out(当答案) 跑一次，期望 _ok
 *   3) 编译 interactor.cpp（若有）→ 只验证能编译（交互协议需要选手程序，无法凭空试跑）
 *   4) 编译 grader.cpp（若有）→ 只验证能编译
 * 每步都打印命令、退出码、stderr，能直接看出是哪一环坏。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const pid = parseInt(process.argv[2], 10);
if (!pid) { console.log('用法: node deploy/probe-problem.js <题目ID>'); process.exit(1); }

const { DatabaseSync } = require('node:sqlite');
const DATA = process.env.OJ_DATA_DIR ? path.resolve(ROOT, process.env.OJ_DATA_DIR) : path.join(ROOT, 'data');
const db = new DatabaseSync(path.join(DATA, 'oj.db'));
const p = db.prepare('SELECT * FROM problems WHERE id=?').get(pid);
if (!p) { console.log('✗ 题目 #' + pid + ' 不存在'); process.exit(1); }
db.close();

const dir = path.join(DATA, 'testdata', String(pid));
console.log('  题目 : #' + p.id + ' ' + p.title);
console.log('  spj  : ' + p.spj + '   problem_type: ' + p.problem_type);
console.log('  数据目录: ' + dir + (fs.existsSync(dir) ? ' ✓' : ' ✗ 不存在'));
const metaPath = path.join(dir, 'meta.json');
if (fs.existsSync(metaPath)) {
  console.log('  meta.json: ' + fs.readFileSync(metaPath, 'utf8').replace(/\s+/g, ' ').slice(0, 300));
}

const gpp = ['g++', 'gcc', 'g++-13', 'g++-12', 'c++'].find((c) => {
  const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
  return r.status === 0;
});
console.log('  编译器: ' + (gpp || '✗ 没找到 g++'));
if (!gpp) process.exit(1);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lczoj-probe-'));
const FLAGS = ['-fno-asm', '-std=c++14', '-O2', '-I', path.join(ROOT, 'testlib')];

function compile(srcName) {
  const src = path.join(dir, srcName);
  if (!fs.existsSync(src)) return { missing: true };
  const out = path.join(TMP, srcName.replace(/\.cpp$/, '') + '.bin');
  const r = spawnSync(gpp, [...FLAGS, '-o', out, src], { encoding: 'utf8', timeout: 120000, cwd: dir });
  return { src, out, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function show(name, c) {
  if (c.missing) { console.log('\n  ' + name + ': 不存在（跳过）'); return false; }
  if (c.status === 0) { console.log('\n  ' + name + ': 编译 ✓ → ' + c.out); return true; }
  console.log('\n  ' + name + ': 编译 ✗（退出码 ' + c.status + '）');
  console.log('    命令: ' + gpp + ' ' + FLAGS.join(' ') + ' -o <out> ' + c.src);
  console.log('    输出: ' + (c.stderr || c.stdout).slice(0, 1500).replace(/\n/g, '\n          '));
  return false;
}

/* ---- 1) SPJ checker：用 1.in / 1.out 跑，输出=答案，应得 _ok ---- */
const ck = compile('checker.cpp');
if (show('checker.cpp', ck)) {
  const inF = path.join(dir, '1.in'), outF = path.join(dir, '1.out'), ansF = path.join(dir, '1.out');
  if (!fs.existsSync(inF)) {
    console.log('  ⚠ 缺 1.in，无法试跑 checker');
  } else {
    const r = spawnSync(ck.out, [inF, outF, ansF], { encoding: 'utf8', timeout: 60000, cwd: dir });
    console.log('  试跑 checker（输出=答案，期望 _ok / 退出码 0）：');
    console.log('    退出码: ' + r.status);
    console.log('    stderr : ' + (r.stderr || '(空)').trim().slice(0, 800));
    if (r.status === 0) console.log('    → checker 自身正常 ✓（若线上仍 WA/RE，问题在评测调用链或选手输出）');
    else console.log('    → checker 自身异常 ✗（退出码非 0 说明 SPJ 逻辑或数据有问题）');
  }
}

/* ---- 2) interactor / grader：只验证能否编译 ---- */
show('interactor.cpp', compile('interactor.cpp'));
show('grader.cpp', compile('grader.cpp'));

/* ---- 3) 数据完备性 ---- */
const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
const ins = files.filter((f) => /\.in$/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
const outs = files.filter((f) => /\.out$/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
console.log('\n  测试数据: ' + ins.length + ' 个 .in / ' + outs.length + ' 个 .out' + (ins.length === outs.length ? '（配对 ✓）' : '（不配对 ✗）'));

console.log('\n  临时目录: ' + TMP + '（可删）');
