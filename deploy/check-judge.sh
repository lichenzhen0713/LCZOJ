#!/usr/bin/env bash
# =============================================================================
#  LCZOJ 通信题 / SPJ（Special Judge）评测自检
#
#  用法（在项目根目录执行，或用第一个参数指定根目录）：
#      bash deploy/check-judge.sh
#      sudo bash deploy/check-judge.sh /www/server/phpstudy/www/oj.lichenzhen.cn
#
#  为什么需要它：
#    通信题要现场编译 interactor.cpp、SPJ 要现场编译 checker.cpp，
#    两者都依赖「g++ 可执行 + testlib.h 在位 + 编译产物能执行」。
#    任何一环坏掉，这两类题就会一起失败（普通题正常）。
#
#  逐项判定，最后给结论。
# =============================================================================
set -u
ROOT="${1:-$(pwd)}"
OK=0; BAD=0
say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { OK=$((OK+1)); printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
bad()  { BAD=$((BAD+1)); printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }

printf '  项目根目录: %s\n' "$ROOT"
[ -f "$ROOT/server.js" ] || { bad "这里不像 LCZOJ 项目根目录（找不到 server.js）"; exit 1; }

# ---------------------------------------------------------------- 1. 编译器
say "1. 编译器（通信题/SPJ 都靠它现场编译）"
if command -v g++ >/dev/null 2>&1; then
  GXX_VER="$(g++ --version 2>&1 | head -1)"
  ok "g++ 存在：$GXX_VER"
  if echo "$GXX_VER" | grep -qE '([0-9]+)\.[0-9]+\.[0-9]+'; then :; fi
else
  bad "没有 g++ → 通信题与 SPJ 100% 会失败（普通题不受影响）"
  warn "修复：apt-get install -y build-essential   （CentOS：yum install -y gcc-c++）"
fi
for c in gcc python3 java php fpc; do
  if command -v "$c" >/dev/null 2>&1; then warn "另发现 $c：$(command -v $c)"; fi
done

# ---------------------------------------------------------------- 2. testlib
say "2. testlib.h（SPJ checker 的头文件）"
if [ -f "$ROOT/testlib/testlib.h" ]; then ok "$ROOT/testlib/testlib.h"; else bad "缺少 $ROOT/testlib/testlib.h"; fi

# ---------------------------------------------------------------- 3. 现场编译
say "3. 现场编译一个 testlib SPJ 并运行（这一步等价于 OJ 判 SPJ 的前半段）"
TMP="$(mktemp -d 2>/dev/null || echo /tmp/lczoj-check-$$)"
mkdir -p "$TMP"
cat > "$TMP/checker.cpp" <<'EOF'
#include "testlib.h"
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    long long got = ouf.readLong();
    long long exp = ans.readLong();
    if (got != exp) quitf(_wa, "expected %lld, found %lld", exp, got);
    quitf(_ok, "answer is %lld", got);
}
EOF
printf '5\n' > "$TMP/in.txt"
printf '5\n' > "$TMP/out.txt"
printf '5\n' > "$TMP/ans.txt"

RUNNABLE=0
if command -v g++ >/dev/null 2>&1; then
  if g++ -fno-asm -std=c++14 -O2 -I "$ROOT/testlib" -o "$TMP/checker" "$TMP/checker.cpp" 2>"$TMP/cerr.txt"; then
    ok "checker 编译成功（-std=c++14 可用）"
    if "$TMP/checker" "$TMP/in.txt" "$TMP/out.txt" "$TMP/ans.txt" >"$TMP/run.txt" 2>&1; then
      ok "checker 运行成功：$(head -1 "$TMP/run.txt")"
      RUNNABLE=1
    else
      RC=$?
      bad "checker 编译成功但运行失败（退出码 $RC）：$(head -2 "$TMP/run.txt")"
      warn "常见原因：/tmp 或本目录挂载了 noexec（不能执行）、SELinux 拦截、缺少动态库"
    fi
  else
    bad "checker 编译失败："
    head -20 "$TMP/cerr.txt" | sed 's/^/      /'
  fi
fi

# ---------------------------------------------------------------- 4. 缓存目录
say "4. 缓存/工作目录可写（judge 以低权限用户运行时会用到）"
for d in "$ROOT/data/spj_cache" "$ROOT/data/judge" "$ROOT/data/testdata"; do
  if [ -d "$d" ]; then
    if [ -w "$d" ]; then ok "可写：$d"; else warn "当前用户不可写：$d（judge 用户需可写，检查 chown/chmod）"; fi
  else
    warn "不存在：$d（首次评测会自动创建）"
  fi
done

# ---------------------------------------------------------------- 5. 系统限制
say "5. 系统限制（noexec / SELinux / ulimit）"
if command -v findmnt >/dev/null 2>&1; then
  for m in /tmp "$TMP"; do
    opt="$(findmnt -no OPTIONS --target "$m" 2>/dev/null || true)"
    [ -n "$opt" ] || continue
    case "$opt" in
      *noexec*) bad "$m 挂载了 noexec → 编译产物无法执行（通信题/SPJ 必失败）" ;;
      *) ok "$m 可执行" ;;
    esac
  done
else
  warn "没有 findmnt，跳过 noexec 检查（手动看 mount | grep -w /tmp）"
fi
if command -v getenforce >/dev/null 2>&1; then
  SE="$(getenforce 2>/dev/null || echo Unknown)"
  if [ "$SE" = "Enforcing" ]; then
    bad "SELinux = Enforcing → 可能拒绝执行 /www 下的编译产物"
    warn "修复（二选一）：setenforce 0（临时）｜setsebool -P httpd_can_network_connect 1 ｜给项目目录打标签"
  else
    ok "SELinux: $SE"
  fi
else
  ok "未启用 SELinux（无 getenforce）"
fi
warn "ulimit -c/-n/-u: $(ulimit -c 2>/dev/null)/$(ulimit -n 2>/dev/null)/$(ulimit -u 2>/dev/null)"

# ---------------------------------------------------------------- 6. 题目资源
say "6. 题目自身的 checker / interactor 是否就位"
found=0
if [ -d "$ROOT/data/testdata" ]; then
  for d in "$ROOT/data/testdata"/*; do
    [ -d "$d" ] || continue
    if [ -f "$d/checker.cpp" ] || [ -f "$d/interactor.cpp" ]; then
      found=$((found+1))
      list=""
      [ -f "$d/checker.cpp" ] && list="$list checker.cpp"
      [ -f "$d/interactor.cpp" ] && list="$list interactor.cpp"
      printf '  · %s →%s\n' "$(basename "$d")" "$list"
    fi
  done
fi
if [ "$found" -eq 0 ]; then
  warn "没找到任何 checker.cpp / interactor.cpp —— 如果你在后台给题目设了 SPJ/交互题，请确认点过「保存 checker.cpp / interactor.cpp」"
else
  ok "找到 $found 个带 checker/interactor 的题目目录"
fi

# ---------------------------------------------------------------- 结论
say "结论"
if [ "$BAD" -eq 0 ]; then
  printf '  \033[1;32m全部通过\033[0m —— 若线上仍失败，请把服务器上评测时的日志贴出来：\n'
  printf '      grep -iE "checker|interactor|交互|SPJ|编译" %s/logs/server.log | tail -50\n' "$ROOT"
  printf '      sudo tail -100 %s/logs/server.err.log\n' "$ROOT"
else
  printf '  \033[1;31m发现 %d 个问题\033[0m（✓ %d 项通过）—— 先修上面标 ✗ 的项，再重试评测\n' "$BAD" "$OK"
fi
printf '\n  临时目录: %s（可删）\n' "$TMP"
