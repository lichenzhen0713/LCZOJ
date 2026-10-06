# 交互题配置与判题说明

> 本文面向**管理员 / 出题人**：讲解 IO 交互题（`interactor.cpp`）与函数式交互题（`grader.cpp` + 头文件）的配置步骤、写法要点与判题规则，并说明选手侧注意事项。
> 普通题、Special Judge、提交答案题的配置见 [USAGE.md](USAGE.md)；部署与升级见 [DEPLOYMENT.md](DEPLOYMENT.md)、[UPDATE.md](UPDATE.md)。

---

## 一、两种交互题

「题目类型」共 **4 种**：普通题 / 提交答案 / 交互题 · IO / 交互题 · 函数式。本文只讲后两种交互类型（前两种见 [USAGE.md](USAGE.md)）。

| 题目类型 | `problem_type` | 评测方式 | 支持的提交语言 |
| --- | --- | --- | --- |
| **交互题 · IO** | `interactive_io` | 选手程序与题目自带的**交互器**通过标准输入输出实时对话，由交互器给出结论 | 全部语言 |
| **交互题 · 函数式** | `interactive_func` | 评测机把 `grader.cpp` 与选手提交**一起编译链接**后运行，由 grader 调用选手实现的函数 | 仅 C / C++ |

交互题也可以勾选 **Special Judge**（开关在题目编辑器顶部的公共设置区，四种题目类型共用）：IO 交互题由交互器把选手的最终答案写入 `argv[2]` 指定的文件，交互结束后交给 checker 判定；函数式交互题则把 grader 的标准输出交给 checker（见第二节与第三节）。

配套文件都放在题目的测试数据目录里（与 `1.in`、`1.out` 同级）：

| 文件 | 位置 | 用途 |
| --- | --- | --- |
| 交互器 | `data/testdata/<题号>/interactor.cpp` | IO 交互题的评测程序（必填） |
| grader | `data/testdata/<题号>/grader.cpp` | 函数式交互题的评测程序（必填，自带 `main()`） |
| 头文件 | `data/testdata/<题号>/<名字>.h` | 函数式交互题的公共接口声明（可多个） |

测试数据本身照常准备：每个测试点的 `.in` 就是**交互器 / grader 要读的隐藏数据**（选手看不到），`.out` 在交互题里可以不填。

---

## 二、后台配置步骤

1. 进入 **管理后台 → 题目管理**，新建题目或点某题的「编辑题目」；
2. 「基本信息 → **题目类型**」选择 `交互题 · IO` 或 `交互题 · 函数式`（下拉共 4 项：普通题 / 提交答案 / 交互题 · IO / 交互题 · 函数式）；选中交互类型后，页面会出现「**交互题配置**」卡片：
   - **交互器源码（interactor.cpp）**：直接粘贴，或点「选择 interactor.cpp 文件」载入本地文件（仅交互题 · IO 显示）；
   - **grader 源码（grader.cpp）**：同上（仅交互题 · 函数式显示）；
   - **头文件**：点「添加头文件」逐个添加，每项填写**名称**（如 `problem.h`）与内容，也可上传文件；行内「删除」移除；保存时**整体替换**该题的头文件列表（未列出的会被删除）；
   - **交互说明**：Markdown / LaTeX，会以「交互说明」区块展示在题目页，用于写清提问格式、函数签名与调用约定；
3. **是否使用 Special Judge（SPJ）在页面顶部的公共设置区统一设置**：题目类型下方就是一个「使用 Special Judge（SPJ）」开关，勾选后紧接着展开 checker 的编辑 / 上传区（**四种题目类型共用同一个开关与同一份 `checker.cpp`**）。交互题勾选后，交互题配置卡片里会多出一段提示：交互题 · IO 的交互器要把选手的最终答案写入 `argv[2]`，交互结束后由 checker 校验 `<输入文件> <交互器输出文件> <答案文件>`；交互题 · 函数式则把 grader 的标准输出交给 checker；
4. 点「**保存题目信息**」——题目类型、SPJ 勾选、交互说明与上述配套源码一并保存（会写入 `data/testdata/<题号>/`）；
5. 再按普通题的方式配置测试数据（`1.in / 1.out`…）与子任务分数。

补充说明：

- **清空文本框后保存 = 删除对应文件**；测试数据 ZIP 上传（覆盖或合并）不会删除交互器 / grader / 头文件 / checker；
- 编辑已有题目时会自动**回填**类型、SPJ 勾选、交互器、grader、头文件、交互说明与 checker，状态行会显示「✓ 已找到 interactor.cpp / grader.cpp」；
- 把题目**改回「普通题」或「提交答案」**不会删除这些文件（只是不再参与评测），改回交互类型即可继续使用；
- checker 的保存方式与普通 SPJ 题完全一致（点「保存 checker.cpp」，或在上传测试数据 ZIP 时一并带上 `checker.cpp`）；
- 交互器与 grader 都按「源码 + 头文件 + 编译参数」哈希缓存在 `data/interactor_cache/`，checker 缓存在 `data/spj_cache/`，**改动后自动重新编译**，同一次评测内只编译一次。

---

## 三、交互题 · IO：`interactor.cpp` 写法要点

### 运行方式（务必先读）

评测机按下面的方式启动交互器，并把**交互器的标准输出接到选手程序的标准输入**、**选手程序的输出接到交互器的标准输入**：

```text
interactor <测试输入文件> <交互器输出文件>
# argv[1] = 该测试点的 .in 文件（隐藏数据）
# argv[2] = 交互器输出文件：交互题开启 SPJ 时，交互器要把选手的最终答案写到这里，供 checker 读取
```

编译命令等价于（testlib 已内置，无需随题上传）：

```text
g++ -fno-asm -std=c++14 -O2 -I<题目数据目录> -I<内置 testlib 目录> interactor.cpp -o interactor
```

### 关于 testlib 的注意

1. 评测机传入两个参数（`<input-file> <output-file>`），因此 **testlib 的 `registerInteraction(argc, argv)` 可以直接使用**（它正好要求这两个参数），调用后 `inf` 指向测试输入文件、`tout` 可用于输出；同时它满足 testlib 的收尾检查要求。
2. 反过来说：**只 `#include "testlib.h"` 而没有在 `main()` 第一行调用 register 函数**的程序，退出时会被 testlib 以 `FAIL`（退出码 3）结束，表现为「判题失败」。想用 testlib 的零散工具（如 `setName()`）又不 register，请在 `main()` 开头调用 `disableFinalizeGuard();`。

三种写法都可以用：

| 写法 | 说明 |
| --- | --- |
| **纯标准 C++（最省心）** | 不 `#include "testlib.h"`，自己用 `fopen(argv[1])` 读隐藏数据、`fopen(argv[2], "w")` 写最终答案、用 `std::cin` / `std::cout` 与选手对话、用 `return 0/1/3` 给结论 |
| **testlib 注册式** | `registerInteraction(argc, argv);` 放在 `main()` 第一行，之后按 testlib 习惯读写（`inf` / `tout` / `std::cin` 均可） |
| **testlib 工具 + 手动退出码** | 在 `main()` 开头 `disableFinalizeGuard();`，之后可以正常使用 `setName()` 等工具，并自行 `return` 退出码 |

### 最小骨架

```cpp
// interactor.cpp（交互题 · IO，不开 SPJ 时也能用）
// 评测机调用：interactor <测试输入文件> <交互器输出文件>
// 对话：交互器 stdout → 选手 stdin；选手 stdout → 交互器 stdin
#include <cstdio>
#include <cstdlib>
#include <string>
#include <iostream>

int main(int argc, char* argv[]) {
    if (argc < 2) {                                   // 评测机调用方式不对 → 判题失败
        fprintf(stderr, "interactor: missing input file\n");
        return 3;
    }
    FILE* f = fopen(argv[1], "r");
    if (!f) { fprintf(stderr, "interactor: cannot open %s\n", argv[1]); return 3; }
    long long x = 0;                                  // 出题人准备的隐藏数据（即该测试点的 .in）
    if (fscanf(f, "%lld", &x) != 1) { fclose(f); return 3; }
    fclose(f);
    // argv[2]：交互器输出文件。开启 SPJ 时把选手的最终答案写进去，checker 会读它作为 ouf。
    FILE* out = (argc >= 3) ? fopen(argv[2], "w") : NULL;

    std::string op;
    long long asked = 0;
    while (std::cin >> op) {
        if (op == "?") {                              // 选手提问：? l r
            long long l = 0, r = 0;
            if (!(std::cin >> l >> r)) { printf("malformed query\n"); fflush(stdout); return 1; }
            if (++asked > 100) { printf("too many queries\n"); fflush(stdout); return 1; }
            std::cout << ((l <= x && x <= r) ? "yes" : "no") << std::endl;   // 回答（endl 自动刷新）
        } else if (op == "!") {                       // 选手宣告答案：! y
            long long y = -1;
            if (!(std::cin >> y)) { printf("malformed answer\n"); fflush(stdout); return 1; }
            if (out) { fprintf(out, "%lld\n", y); fclose(out); }   // 交给 checker 的最终答案
            printf("expected %lld, got %lld, queries = %lld\n", x, y, asked);
            fflush(stdout);                           // 结论 / 原因：会显示在该测试点的判题详情里
            return y == x ? 0 : 1;                    // 0 = AC，1 = WA
        } else {
            printf("unknown command: %s\n", op.c_str());
            fflush(stdout);
            return 1;
        }
    }
    // 选手提前退出 / 管道断开：按判题失败处理，避免把「没答完」误判成 AC
    printf("contestant closed the pipe early\n");
    fflush(stdout);
    if (out) fclose(out);
    return 3;
}
```

要点：

- **必须刷新输出缓冲**：`std::endl`、`fflush(stdout)`、`std::cout.flush()` 任一均可，否则选手程序会一直等不到回答而超时；
- **交互器的 stdout 既是「给选手的回答」，也是「判题消息」**：评测机把交互器的标准输出接到选手的输入，同时记录下来作为该测试点的消息展示在提交详情中；不想让选手读到的诊断信息请写 `stderr`（仅当 stdout 为空时，评测机才改用 `stderr` 作为消息）；
- **`argv[2]` 只写选手的最终答案**（开启 SPJ 时 checker 会读它），不要把对话过程写进去；
- 不要在交互器里读写别的文件、也不要依赖当前工作目录；
- 每个测试点都会用**同一个交互器**重新启动一次，`argv[1]` 指向该测试点的输入文件。

### 开启 Special Judge 时

在题目编辑器顶部勾选「使用 Special Judge（SPJ）」后，判定不再只看交互器退出码，而是由 checker 决定：

```text
checker <输入文件> <交互器输出文件> <答案文件>        # 即 testlib 的 in / ouf / ans
```

- 交互器负责把选手的最终答案写入 `argv[2]`（`ouf`），并在交互正常结束后以退出码 `0` 退出；
- checker 与普通 SPJ 题完全一样：`registerTestlibCmd(argc, argv)` 之后用 `inf.readXxx()` 读输入、`ouf.readXxx()` 读选手答案、`ans.readXxx()` 读标准答案；`quitf(_ok, ...)` 通过、`quitf(_wa, ...)` 错误、`quitp(比例, ...)` 部分分；
- checker 退出码约定：`0`=AC（可输出 0~1 或 1~100 的数值作为部分分比例）、`1`=WA、`2`=格式错误（按 WA）、`3`=checker 异常；
- checker 的编辑 / 上传入口就在开关下方（`checker.cpp 内容`），与普通题共用同一套，写法见 [USAGE.md](USAGE.md) 的「Special Judge」一节。

### 退出码 → 判定（未开启 SPJ 时）

| 交互器退出码 | 判定 | 说明 |
| --- | --- | --- |
| `0` | **AC** | 通过（testlib 的 `_ok`） |
| `1` | **WA** | 答案错误（`_wa`） |
| `2` | **WA（格式错误）** | 按 WA 处理（`_pe`） |
| `3` | **判题失败（JE / SE）** | 交互器自身异常、参数不对、数据缺失（`_fail`） |
| `4` | **WA** | 多余输出等（`_dirt`） |
| `7` | **WA（部分分）** | 交互题按对错计分，`_points` 会记为 0 分并附上提示 |
| 其它 | 按选手程序退出码判 RE | 交互器没有给出结论时（如被拖死、崩溃） |

交互器的消息（stdout，其次 stderr）会出现在**提交详情 →「交互器消息」**区块与测试点悬停提示里，配上「交互器退出码 / 程序退出码」，是排查问题最快的方式。

---

## 四、交互题 · 函数式：`grader.cpp` + 头文件

### 评测方式

评测机把 grader 与选手代码**一起编译链接**（选手代码里通常只实现一个函数，没有 `main()`）：

```text
g++ -fno-asm -std=c++14 -O2 -I<题目数据目录> -I<内置 testlib 目录> grader.cpp <选手源码> -o main
```

随后以该测试点的 `.in` 作为标准输入运行这个可执行文件：

- grader 必须**自带 `main()`**，负责读入隐藏数据、调用选手实现的函数、给出结论；
- 头文件（如 `problem.h`）放在题目数据目录里，grader 与选手代码都用 `#include "problem.h"` 引用；它声明了选手要实现的函数与 grader 提供的接口函数；
- **退出码 `0` 判 AC**，非 0 判 WA（该测试点的消息取 grader 的 stdout，stdout 为空时用 stderr）；
- 如果某个测试点的 `.out` 非空，则该测试点改为**按输出比对**（先比输出、再看退出码）；
- **勾选 Special Judge 时**：程序的**标准输出**作为 `ouf` 交给 checker，即 `checker <输入文件> <grader 的标准输出> <答案文件>`；因此 grader 应把选手的最终答案打印到 stdout（调试信息请写到 stderr，或按题目约定打印），再由 checker 判定对错与部分分；
- **仅支持 C / C++**：其它语言提交会被直接判为系统错误并提示「函数式交互题仅支持 C/C++ 提交」。

### 写法要点（可参考种子演示题「函数式交互测试题（不许偷看）」）

`problem.h`（公共接口，选手与 grader 都会包含）：

```cpp
#ifndef LCZOJ_PROBLEM_H
#define LCZOJ_PROBLEM_H

long long ask(long long l, long long r);   // grader 提供：询问隐藏值 x 是否满足 l <= x <= r
void answer(long long y);                  // grader 提供：提交答案 y，调用后程序立刻结束

void run(int n, long long k);              // 选手实现：n 为上界，k 为 ask 次数上限

#endif
```

`grader.cpp`（自带 `main()`）：

```cpp
#include "problem.h"
#include <cstdio>
#include <cstdlib>

static long long g_x = 0, g_used = 0, g_limit = 0;
static bool g_answered = false;

long long ask(long long l, long long r) {
    if (g_answered) exit(1);                       // 调用约定被破坏 → 判 WA
    if (l < 1 || r > 1000000000LL || l > r) exit(1);
    if (++g_used > g_limit) exit(1);                // 超过次数上限 → 判 WA
    return (l <= g_x && g_x <= r) ? 1 : 0;
}

void answer(long long y) {
    g_answered = true;
    if (y == g_x) { printf("OK: x = %lld, ask = %lld\n", g_x, g_used); exit(0); }   // exit(0) → AC
    printf("WRONG: expected %lld, got %lld\n", g_x, y);
    exit(1);                                                                        // 非 0 → WA
}

int main() {
    int n = 0; long long k = 0;
    if (scanf("%d %lld", &n, &k) != 2) return 1;    // 读隐藏参数（来自测试点 .in）
    g_x = (1 + (long long)n) / 2;                   // 出题人自己决定的隐藏值
    g_limit = k;
    run(n, k);                                      // 调用选手实现的函数
    printf("FAIL: run() returned without answer()\n");
    return 1;                                       // 选手没给答案 → WA
}
```

要点：

- grader 的输出（stdout，其次 stderr）会作为该测试点的消息显示在提交详情里，用 `printf` 写清原因即可；
- 选手代码里**不要自带 `main()`**，否则链接会因重复定义失败（报「与 grader 一起编译失败」）；
- 选手与 grader 的**函数签名必须完全一致**（含命名空间 / 参数类型），建议把签名集中写在头文件里；
- 同样不要在代码里读写文件或依赖网络。

---

## 五、选手侧注意事项

**IO 交互题**

- 通过标准输入输出与交互器对话，**不要读写任何文件**（也不要 `freopen` / 打开 `interactor.cpp`）；
- 每次输出后**刷新缓冲区**（C++：`std::endl` 或 `fflush(stdout)`；Python：`print(..., flush=True)`；Java：`System.out.flush()`），否则会因等不到回答而超时；
- **不要输出多余的调试信息**：交互器的输入流被你的输出塞进无关内容后会判 WA（通常报格式错误或多余输出）；
- 注意询问次数 / 输出格式的限制，按题目页「**交互说明**」区块给出的约定实现；
- 正常结束时让程序返回 `0`；不要用崩溃、`abort()`、未捕获异常等方式退出（会被判为运行时错误）。

**函数式交互题**

- **只实现题面指定的函数，不要写 `main()`**，也不要自己读标准输入输出；
- 用题目给出的头文件（如 `#include "problem.h"`）获取接口声明，签名必须与题面一致；
- **仅支持 C / C++** 提交（语言下拉里只有 C 与 C++）；
- 题目页顶部会给出「函数式交互题」提示与「交互说明」。

**本地自测**

- IO 交互题：按交互说明自己写一个「对手程序」（读隐藏数据、按约定回答），再把两个进程的标准输入输出**互相接通**（对手的 stdout → 你的 stdin，你的 stdout → 对手的 stdin；Linux / macOS 可用 `mkfifo` 或一条小脚本，Windows 可写几十行脚本或用评测机同样的方式），也可以先在代码里模拟几组对话验证逻辑；
- 函数式交互题：把 `grader.cpp`、`problem.h` 与自己的代码放到同一目录，执行 `g++ -O2 -std=c++14 -I. grader.cpp my.cpp -o main && ./main < 1.in`，与评测命令一致；
- 评测机上编译时已内置 testlib 头文件与题目数据目录的 `-I`，本地按同样参数编译能最大程度复现评测结果。

---

## 六、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 所有测试点都提示「题目标记为 IO 交互题，但测试数据目录中缺少 interactor.cpp」 | 只选了题目类型但没保存交互器源码；在「交互题配置」里粘贴 / 上传后点「保存题目信息」 |
| 所有测试点都是「判题失败（JE）」 | 看判题消息：① 用了 testlib 却没在第一行调用 register 函数 → 换成 `registerInteraction(argc, argv);`（评测机正好传 `<input-file> <output-file>` 两个参数）或在 `main()` 开头加 `disableFinalizeGuard();`；② 数据文件读不到（检查 `argv[1]`、交互器是否返回 3 并打印原因）；③ 交互器崩溃或参数判断写错 |
| **交互题 + SPJ 全是 WA / 判题失败** | ① **交互器没有把选手的最终答案写入 `argv[2]`**（最常见：只打印到 stdout），checker 读到的 `ouf` 是空的；② checker 参数顺序按 testlib 的 in / ouf / ans，别把变量读错（`inf` 读输入、`ouf` 读交互器输出文件、`ans` 读标准答案）；③ 交互器应先把答案写完并关闭文件，再以退出码 `0` 结束；④ checker 自己要 `registerTestlibCmd(argc, argv)` 并用 `quitf` 结束 |
| 本地能过、评测 WA（格式错误 / 多余输出） | 输出了调试信息（如把中间量打印到了 stdout）→ 那是发给交互器的数据流，必须删掉或改到 stderr（注意 stderr 也不要打印太多）；没有刷新缓冲区导致答案发出后直接退出 |
| 提交后一直「评测中」/ 超时 | 交互器与选手互相等待：检查双方是否都刷新了缓冲、是否有一方在读不可能的输入；询问次数过多也会超时 |
| 函数式交互题报「与 grader 一起编译失败」 | 检查是否自带 `main()`、函数签名是否与题面 / 头文件一致、是否漏了 `#include`；编译日志会显示在提交详情的编译信息里 |
| 函数式交互题提交 Python / Java 等语言 | 不支持：函数式交互题需要把 grader 与选手代码一起编译链接，语言下拉里只保留 C 与 C++ |
| 想要部分分 | 普通交互题按「每个测试点 AC / WA」计分（交互器退出码 `7` 会记为 0 分并附提示）；需要真正的部分分就**给交互题勾选 SPJ**，让 checker 用 `quitp(比例, ...)` 打分，或通过子任务分组计分 |

---

## 七、相关文档

| 文档 | 内容 |
| --- | --- |
| [USAGE.md](USAGE.md) | 使用说明：普通题 / SPJ / 提交答案题 / 测试数据与子任务配置 |
| [CUSTOMIZATION.md](CUSTOMIZATION.md) | 自定义指南：外观、权限、积分扩展、Special Judge |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署详解：部署方式对照、systemd、Nginx、HTTPS、备份 |
| [FAQ.md](FAQ.md) | 常见问题解答 |
| [CHANGELOG.md](CHANGELOG.md) | 版本日志 |
