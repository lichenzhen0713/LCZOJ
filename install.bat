@echo off
REM 先把控制台代码页切到 936（简体中文）：既保证中文提示不乱码，也保证在非 936
REM 代码页的窗口里 cmd 仍按 GBK 正确解析本文件（在英文系统上失败也不影响运行）。
chcp 936 >nul 2>&1
REM ============================================================================
REM  LCZOJ 在线评测系统 - Windows 一键部署脚本（小白友好版）
REM  只需双击运行一次，脚本会自动：
REM    1) 检测 Node.js，缺失或版本过低时自动下载安装（使用国内镜像源，加速下载）
REM    2) 自动安装全部评测语言编译器（Python / G++ / Pascal / PHP / JDK / Go / Rust）
REM       - 通过 winget（Windows 包管理器）静默安装，显示实时进度
REM       - 已安装的语言自动跳过；winget 不可用时给出下载链接
REM    3) 检查端口占用：80 被占用时显示占用进程并自动改用 8080 / 8081 / 8082
REM    4) 后台启动网站，等待健康检查通过后自动打开浏览器；
REM       启动失败不会一闪即退，会打印占用情况与服务日志尾部便于排查
REM    5) 醒目显示管理员账号 admin 与初始密码（data\admin-password.txt，改密后自动删除）
REM  临时指定其它端口：set PORT=9000 后运行；不想自动打开浏览器：set OJ_NO_BROWSER=1
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
REM ---- 4. 创建数据/日志目录，并选择可用端口（80 被占用时自动改用 8080/8081/8082） ----
if not exist data mkdir data
if not exist logs mkdir logs
if /i "%~1"=="--daemon" set "DAEMON_MODE=1"
if "%PORT%"=="" set "PORT=80"
set "PORT_WANT=%PORT%"
set "REUSE_RUNNING="
set "SERVER_PID="
call :PortBusy %PORT_WANT%
if not defined PORT_BUSY goto :PortOK
set "PORT_PID_WANT=%PORT_PID%"
set "PORT_PNAME_WANT=%PORT_PNAME%"
echo.
echo [警告] 端口 %PORT_WANT% 已被占用：占用进程 PID = %PORT_PID_WANT%（进程名 %PORT_PNAME_WANT%）
echo        常见原因：IIS / Nginx / Apache 等网站服务，或上一次没有关闭的 LCZOJ。
call :ProbeHealth %PORT_WANT%
if not defined HEALTH_UP goto :PortSwap
echo [提示] 该端口上已经有 LCZOJ 服务在运行（健康检查通过），直接复用它，不再重复启动。
set "REUSE_RUNNING=1"
goto :PortOK

:PortSwap
echo        该端口上的程序不是 LCZOJ（或尚未就绪），将自动改用备用端口启动。
echo        如需继续使用 %PORT_WANT% 端口：先结束占用进程 taskkill /f /pid %PORT_PID_WANT%
echo        再重新运行本脚本。IIS 可执行 net stop w3svc，面板站点请在面板里停止。
call :PickFreePort
if defined PORT goto :PortSwapped
echo.
echo [错误] 备用端口 8080 / 8081 / 8082 全部被占用，无法自动启动服务。
echo        请先释放其中一个端口，或执行 set PORT=9000 指定其它端口后重新运行本脚本。
echo ------------------------------------------------------------
pause
exit /b 1

:PortSwapped
echo [提示] %PORT_WANT% 被占用，已改用 %PORT% 端口。
echo        若想恢复使用 %PORT_WANT%：先结束占用进程 taskkill /f /pid %PORT_PID_WANT% 再重新运行。

:PortOK
REM ---- 5. 后台启动服务，并轮询健康检查等待就绪（最多约 30 秒） ----
if not exist "server.js" goto :NoServer
if not defined NODE_EXE for /f "delims=" %%p in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%p"
if not defined NODE_EXE goto :NoNode
echo.
echo 启动 LCZOJ 服务（端口 %PORT%）...
echo 访问地址: http://localhost:%PORT%
echo 管理员账号: admin
if defined REUSE_RUNNING goto :Ready
echo.
echo 正在后台启动服务，并等待健康检查通过（最多约 30 秒）...
REM 注意：这里不能用 for /f 捕获 PowerShell 的输出：子进程会继承那个管道句柄，
REM 使 for /f 永远等不到管道关闭而卡住。所以启动后改用端口反查服务进程 PID。
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%CD%\logs\server.log' -RedirectStandardError '%CD%\logs\server.err.log'"
if errorlevel 1 goto :StartFailed
echo 服务进程已启动，正在等待就绪...
call :WaitHealth %PORT%
if defined HEALTH_UP goto :Ready
goto :NotReady

:NoServer
echo.
echo [错误] 当前目录下找不到 server.js，无法启动服务。
echo        请确认 install.bat 与 server.js 放在同一个目录中。
echo        当前目录：%CD%
echo ------------------------------------------------------------
echo 请把以上内容复制给管理员。
pause
exit /b 1

:NoNode
echo.
echo [错误] 未找到 node 命令，无法启动服务（Node.js 可能没有安装成功）。
echo        请手动安装 Node.js 22.5 及以上版本后重新运行本脚本：
echo        https://nodejs.org/zh-cn/download
echo ------------------------------------------------------------
echo 请把以上内容复制给管理员。
pause
exit /b 1

:StartFailed
echo.
echo [错误] node server.js 启动命令执行失败（错误原因见上面的提示）。
call :ShowLogTail
echo 请把以上整段内容复制给管理员，便于定位问题。
pause
exit /b 1

:NotReady
echo.
echo [错误] 服务在约 30 秒内仍未就绪（健康检查 http://127.0.0.1:%PORT%/api/health 没有返回 up）。
call :ShowLogTail
echo 端口监听检查（端口 %PORT%）：
netstat -ano | findstr /r /c:":%PORT% .*LISTENING"
echo   （上面没有输出，说明本机没有进程在监听该端口）
echo.
echo 请把以上整段内容复制给管理员，便于定位问题。
echo 也可以在本窗口手动前台运行查看完整报错：node server.js
echo.
pause
exit /b 1

REM ---- 6. 服务已就绪：显示访问地址与管理员初始密码 ----
:Ready
echo.
echo ==============================================
echo   LCZOJ 部署完成
echo ==============================================
echo   访问地址:   http://localhost:%PORT%
if not "%PORT%"=="%PORT_WANT%" echo                （%PORT_WANT% 端口被占用，本次改用 %PORT% 端口）
if defined REUSE_RUNNING echo                （该端口已有 LCZOJ 服务在运行，未重复启动新实例）
if defined DAEMON_MODE echo                （--daemon 后台运行模式）
echo   管理员账号: admin
call :ShowAdminPwd
echo   服务日志:   logs\server.log 、 logs\server.err.log
call :PortBusy %PORT%
if defined PORT_PID if not defined SERVER_PID set "SERVER_PID=%PORT_PID%"
if defined SERVER_PID echo   停止服务:   taskkill /f /pid %SERVER_PID%
if not defined SERVER_PID echo   停止服务:   在「任务管理器」里结束 node.exe 进程
echo ==============================================
if "%OJ_NO_BROWSER%"=="1" goto :NoBrowser
start "" "http://127.0.0.1:%PORT%/"
echo   已尝试自动打开浏览器；若没有弹出，请手动访问上面的访问地址。
goto :AfterBrowser
:NoBrowser
echo   请手动在浏览器中打开上面的访问地址。
:AfterBrowser
echo.
echo [提示] 服务已在后台运行：关闭本窗口不会停止服务，日志见 logs\server.log。
echo        下次启动直接双击 install.bat；停止服务用上面那条 taskkill 命令。
echo.
pause
exit /b 0

REM ============================================================================
REM 子过程：判断端口是否正在被监听（%1 = 端口号）
REM   命中时设置 PORT_BUSY=1、PORT_PID=占用进程 PID、PORT_PNAME=进程名
REM   只匹配带 LISTENING 的监听行，避免把「连接到该端口」的会话误判为占用
REM ============================================================================
:PortBusy
set "PORT_BUSY="
set "PORT_PID="
set "PORT_PNAME="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do if not defined PORT_PID set "PORT_PID=%%p"
if not defined PORT_PID goto :eof
set "PORT_BUSY=1"
for /f "tokens=1" %%n in ('tasklist /fi "pid eq %PORT_PID%" /nh 2^>nul') do set "PORT_PNAME=%%n"
if not defined PORT_PNAME set "PORT_PNAME=未知进程"
goto :eof

REM ============================================================================
REM 子过程：依次尝试备用端口 8080 / 8081 / 8082，取第一个空闲端口写入 PORT
REM ============================================================================
:PickFreePort
set "PORT="
for %%P in (8080 8081 8082) do call :TryPort %%P
goto :eof

:TryPort
if defined PORT goto :eof
call :PortBusy %1
if defined PORT_BUSY goto :eof
set "PORT=%1"
goto :eof

REM ============================================================================
REM 子过程：探测 %1 端口上是否已有 LCZOJ 在运行（健康检查返回 up 即算命中）
REM ============================================================================
:ProbeHealth
set "HEALTH_UP="
for /f "delims=" %%r in ('powershell -NoProfile -Command "try { $c = (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:%~1/api/health -TimeoutSec 3).Content; Write-Output $c } catch { }" 2^>nul') do set "HEALTH_UP=%%r"
goto :eof

REM ============================================================================
REM 子过程：轮询 %1 端口的健康检查，最多约 30 秒；返回 up 时设置 HEALTH_UP
REM ============================================================================
:WaitHealth
set "HEALTH_UP="
for /f "delims=" %%r in ('powershell -NoProfile -Command "$d = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $d) { try { $c = (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:%~1/api/health -TimeoutSec 3).Content; if ($c) { Write-Output $c; exit 0 } } catch { }; Start-Sleep -Milliseconds 500 }; exit 1" 2^>nul') do set "HEALTH_UP=%%r"
goto :eof

REM ============================================================================
REM 子过程：打印服务日志尾部（启动失败时用于定位原因，最多各 20 行）
REM ============================================================================
:ShowLogTail
echo ------------------------------------------------------------
if not exist "logs\server.log" goto :ShowLogTail1
echo 服务日志尾部（logs\server.log，最后 20 行）：
powershell -NoProfile -Command "Get-Content -LiteralPath 'logs\server.log' -Tail 20 -Encoding UTF8"
goto :ShowLogTail2
:ShowLogTail1
echo （logs\server.log 不存在：服务可能没有成功启动，请检查上面的报错）
:ShowLogTail2
if not exist "logs\server.err.log" goto :ShowLogTail3
powershell -NoProfile -Command "$c = Get-Content -LiteralPath 'logs\server.err.log' -Tail 20 -Encoding UTF8; if ($c) { Write-Output '错误输出尾部（logs\server.err.log，最后 20 行）：'; $c } else { Write-Output '（logs\server.err.log 为空，没有错误输出）' }"
goto :ShowLogTail4
:ShowLogTail3
echo （logs\server.err.log 不存在或没有错误输出）
:ShowLogTail4
echo ------------------------------------------------------------
goto :eof

REM ============================================================================
REM 子过程：检测工具，缺失则用 winget 自动安装（显示进度），并将 bin 目录加入用户 PATH
REM   %1 = 命令名（where 检测用）
REM   %2 = 显示名
REM   %3 = winget 包 ID
REM   %4 = 安装后需加入 PATH 的目录（可空；相对路径基于 %USERPROFILE%）
REM   %5 = 手动下载链接
REM ============================================================================
REM ============================================================================
REM 子过程：醒目显示初始管理员密码（首次初始化时由 src/db.js 的 seed() 随机生成，
REM   明文写入 数据目录\admin-password.txt；用户首次登录改密后该文件会被自动删除）
REM   文件中的 admin-password: <口令> 行是纯 ASCII，交给 PowerShell 打印可避免
REM   口令里的感叹号、连字符、百分号等特殊字符会被 cmd 当成命令语法，交给 PowerShell 打印才原样。
REM   数据目录可用环境变量 OJ_DATA_DIR 改写（与 src/config.js 的规则一致）。
REM ============================================================================
:ShowAdminPwd
set "PWDFILE=data\admin-password.txt"
if not "%OJ_DATA_DIR%"=="" set "PWDFILE=%OJ_DATA_DIR%\admin-password.txt"
if not exist "%PWDFILE%" goto :ShowAdminPwdMissing
powershell -NoProfile -Command "$l = Get-Content -LiteralPath '%PWDFILE%' -Encoding UTF8 | Where-Object { $_ -like 'admin-password:*' } | Select-Object -First 1; if (-not $l) { exit 2 }; $p = ($l -split ': ', 2)[1]; Write-Output ''; Write-Output '  **************** 请立即记录以下登录信息 ****************'; Write-Output '    管理员账号:  admin'; Write-Output ('    初始密码:    ' + $p); Write-Output '  ********************************************************'; Write-Output '    首次登录后会强制要求修改密码；'; Write-Output '    初始密码文件：admin-password.txt，改密后会自动删除；'; Write-Output '    忘记密码：运行 reset.bat 重置数据后会重新生成初始密码。'; Write-Output ''"
if errorlevel 1 goto :ShowAdminPwdFallback
goto :eof

:ShowAdminPwdFallback
echo    初始密码:   未能自动解析，请用记事本打开 %PWDFILE% 查看：
findstr /b /c:"admin-password:" "%PWDFILE%"
goto :eof

:ShowAdminPwdMissing
echo    初始密码:   未找到初始密码文件 %PWDFILE%
echo                （通常表示你已改过密码，直接用你的密码登录；改密后该文件会自动删除）
echo                忘记密码可运行 reset.bat 重置数据后重新生成。
goto :eof

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
  echo   [错误] %2 自动安装失败（错误码 !WINGET_EXIT!，可手动下载：%5）
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
