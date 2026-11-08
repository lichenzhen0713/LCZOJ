@echo off
chcp 65001 >nul
rem ============================================================================
rem  LCZOJ × 小皮面板 · 双击即部署（三步）
rem
rem  用法：把整个项目解压到任意英文路径（如 C:\phpstudy_pro\WWW\lczoj），
rem        双击本文件即可；参数会透传给 deploy\xiaopi-onekey.js：
rem          xiaopi-onekey.bat --check            只检查环境
rem          xiaopi-onekey.bat --port 8080        换端口
rem          xiaopi-onekey.bat --no-compilers     跳过评测语言
rem ============================================================================
setlocal

cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [LCZOJ] 没有找到 node 命令。
  echo          请先安装 Node.js v24（或 ^>= v22.5）：https://nodejs.org/zh-cn/download
  echo          安装时勾选 "Add to PATH"，装完【重新打开】这个窗口再双击一次。
  echo.
  pause
  exit /b 1
)

node deploy\xiaopi-onekey.js %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo  [LCZOJ] 未完成（退出码 %RC%），请把上面的报错发给我。
pause
endlocal & exit /b %RC%
