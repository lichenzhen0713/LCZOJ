@echo off
REM ============================================================================
REM  LCZOJ 在线评测系统 - Windows 一键部署脚本（小白友好版）
REM  只需双击运行一次，脚本会自动：
REM    1) 检测 Node.js，缺失或版本过低时自动下载安装（使用国内镜像源，加速下载）
REM    2) 自动安装全部评测语言编译器（Python / G++ / Pascal / PHP / JDK / Go / Rust）
REM       - 通过 winget（Windows 包管理器）静默安装，显示实时进度
REM       - 已安装的语言自动跳过；winget 不可用时给出下载链接
REM    3) 启动网站
REM  只检测环境而不安装 / 不启动：install.bat --check
REM  本文件必须以 CRLF 换行、GBK(ANSI) 编码保存，否则 cmd 可能解析异常。
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==============================================
echo   LCZOJ 在线评测系统 - 一键部署
echo ==============================================

set "CHECK_ONLY="
if /i "%~1"=="--check" set "CHECK_ONLY=1"
if defined CHECK_ONLY echo [--check] 仅检测环境：不安装编译器、不启动服务
REM ---- 0. 检测是否管理员（影响部分编译器静默安装） ----
net session >nul 2>&1
if errorlevel 1 (
  echo [提示] 当前不是管理员身份。部分编译器安装可能需要管理员权限，
  echo        如安装失败请右键本脚本选择「以管理员身份运行」。
)

REM ---- 1. 确保 Node.js >= 22.5 ----
set "NODE_OK="
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
  echo 检测到 Node.js: !NODEVER!
  for /f "tokens=1,2 delims=." %%a in ("!NODEVER:v=!") do (
    set "NODEMAJOR=%%a"
    set "NODEMINOR=%%b"
  )
  if !NODEMAJOR! GTR 22 set "NODE_OK=1"
  if !NODEMAJOR! EQU 22 (
    if !NODEMINOR! GEQ 5 set "NODE_OK=1"
  )
)

if defined CHECK_ONLY if not defined NODE_OK echo [--] 未检测到 Node.js 22.5+（--check 模式，未下载安装）
if not defined NODE_OK if not defined CHECK_ONLY (
  echo.
  echo 未检测到可用的 Node.js（需要 22.5 或更高版本），正在自动下载安装…
  echo 下载源: 阿里云 npmmirror 国内镜像（速度更快）
  echo 首次安装需要几分钟，请耐心等待（可能需要管理员权限）...
  REM 优先使用国内镜像，失败回退官方源
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-x64.msi' -OutFile '%TEMP%\lczoj-node.msi' } catch { Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-x64.msi' -OutFile '%TEMP%\lczoj-node.msi' }"
  if errorlevel 1 (
    echo [错误] Node.js 下载失败，请检查网络。
    echo 也可以手动安装后重新运行本脚本：https://nodejs.org/zh-cn/download
    pause
    exit /b 1
  )
  msiexec /i "%TEMP%\lczoj-node.msi" /qn /norestart
  if errorlevel 1 (
    echo [错误] Node.js 安装失败，请手动安装后重新运行本脚本。
    pause
    exit /b 1
  )
  set "PATH=%PATH%;C:\Program Files\nodejs"
  echo Node.js 安装完成
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 仍未找到 Node.js，请安装后重试：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo Node.js 版本: !NODEVER!

REM ---- 2. 检测 winget（Windows 包管理器） ----
set "WINGET_OK="
where winget >nul 2>nul
if not errorlevel 1 set "WINGET_OK=1"
if not defined WINGET_OK (
  echo.
  echo [提示] 未检测到 winget（Windows 包管理器），无法自动安装编译器。
  echo        将跳过自动安装；评测时对应语言不可用。
  echo        可先安装 winget：https://aka.ms/getwinget  后重新运行本脚本。
)

REM ---- 3. 自动安装评测语言编译器（显示实时进度） ----
REM call :EnsureTool 命令名 显示名 winget包ID 安装后需加入PATH的目录(可空) 下载链接
echo.
echo 自动安装评测语言编译器（已安装的自动跳过，未安装的通过 winget 静默安装）：
call :EnsureTool python "Python 3" "Python.Python.3.12" "" "https://www.python.org/downloads/"
call :EnsureTool py "Python 3 (py 启动器)" "Python.Python.3.12" "" "https://www.python.org/downloads/"
call :EnsureTool g++ "G++（C/C++，MinGW-w64）" "BrechtSanders.WinLibs.POSIX.UCRT" "%USERPROFILE%\mingw64\bin" "https://winlibs.com/"
call :EnsureTool fpc "Free Pascal" "FreePascal.FreePascalCompiler" "" "https://www.freepascal.org/download.html"
call :EnsureTool php "PHP" "PHP.PHP.8.4" "" "https://windows.php.net/download/"
call :EnsureTool javac "JDK 21（OpenJDK）" "Microsoft.OpenJDK.21" "" "https://learn.microsoft.com/java/openjdk/download"
call :EnsureTool go "Go" "GoLang.Go" "" "https://go.dev/dl/"
call :EnsureTool rustc "Rust" "Rustlang.Rustup" "%USERPROFILE%\.cargo\bin" "https://rustup.rs/"

REM 重新检测一遍并汇总
echo.
echo ========== 语言工具链检测结果 ==========
where python >nul 2>nul && echo   [OK] Python3 || where python3 >nul 2>nul && echo   [OK] Python3 || echo   [--] Python3
where g++ >nul 2>nul && echo   [OK] G++（C/C++） || echo   [--] G++（C/C++）
where fpc >nul 2>nul && echo   [OK] FreePascal || echo   [--] FreePascal
where php >nul 2>nul && echo   [OK] PHP || echo   [--] PHP
where javac >nul 2>nul && echo   [OK] JDK || echo   [--] JDK
where go >nul 2>nul && echo   [OK] Go || echo   [--] Go
where rustc >nul 2>nul && echo   [OK] Rust || echo   [--] Rust
echo ==========================================
echo.
echo [提示] 若刚安装的语言仍显示 [--]，请关闭本窗口后重新运行一次本脚本
echo        （安装程序会刷新系统 PATH，新窗口才能生效）。

if defined CHECK_ONLY (
  echo.
  echo [--check] 环境检测完成（未安装任何软件、未启动服务）。
  echo           安装全部编译器并启动网站：直接运行 install.bat
  pause
  exit /b 0
)
REM ---- 4. 创建数据目录并启动 ----
if not exist data mkdir data
if "%PORT%"=="" set PORT=80
echo.
echo 启动 LCZOJ 服务（端口 %PORT%）...
echo 访问地址: http://localhost:%PORT%
echo 管理员账号: admin（初始密码在首次启动时随机生成，启动日志会显示，并写入 data\admin-password.txt）
echo ==============================================
echo 提示：关闭本窗口后服务会停止。如需长期运行，
echo      可改用 install.bat --daemon（后台运行）。
if "%1"=="--daemon" (
  start "LCZOJ" /min cmd /k "cd /d %~dp0 && node server.js"
  echo LCZOJ 已在后台运行（最小化窗口 = 服务控制台）
  pause
  exit /b 0
)
node server.js
pause
exit /b 0

REM ============================================================================
REM 子过程：检测工具，缺失则用 winget 自动安装（显示进度），并将 bin 目录加入用户 PATH
REM   %1 = 命令名（where 检测用）
REM   %2 = 显示名
REM   %3 = winget 包 ID
REM   %4 = 安装后需加入 PATH 的目录（可空；相对路径基于 %USERPROFILE%）
REM   %5 = 手动下载链接
REM ============================================================================
:EnsureTool
where %1 >nul 2>nul
if not errorlevel 1 (
  echo   [OK] %2 已安装
  goto :eof
)
if not defined WINGET_OK (
  echo   [--] %2 未安装（无 winget，手动下载：%5）
  goto :eof
)
if defined CHECK_ONLY (
  echo   [--] %2 未安装（--check 模式，未执行 winget install %3）
  goto :eof
)
echo   [..] 正在安装 %2 ...
echo   ------------------------------------------------------------
REM winget 自身会显示下载进度。注意：winget 没有 --progress-bar 参数，
REM 传入不存在的参数会直接报「当前命令无法识别参数名称」并中断本次安装。
winget install --id %3 --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
set "WINGET_EXIT=!errorlevel!"
echo   ------------------------------------------------------------
if not "!WINGET_EXIT!"=="0" (
  echo   [!!] %2 自动安装失败（错误码 !WINGET_EXIT!，可手动下载：%5）
  goto :eof
)
echo   [+] %2 安装完成
REM 加入用户 PATH（若指定了目录且目录存在）
if not "%4"=="" (
  if exist "%4" call :AddUserPath "%4"
)
goto :eof

REM ============================================================================
REM 子过程：把目录加入用户 PATH（避免重复；写用户级注册表，无需管理员）
REM   %1 = 目录
REM ============================================================================
:AddUserPath
for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USERPATH=%%b"
if not defined USERPATH set "USERPATH=%1"
echo %USERPATH% | find /i "%1" >nul
if errorlevel 1 (
  set "NEWPATH=%USERPATH%;%1"
  reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "!NEWPATH!" /f >nul
  echo   [i] 已将 %1 加入用户 PATH（新窗口生效）
)
goto :eof
