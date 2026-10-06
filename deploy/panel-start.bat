@echo off
chcp 65001 >nul
rem ============================================================================
rem  LCZOJ 前台启动脚本（Windows 面板 / 宝塔 Windows / 小皮面板 / 计划任务）
rem
rem  用法：双击运行，或在面板「计划任务 / 进程守护」里把启动命令填成：
rem        cmd /c "cd /d C:\path\to\lczoj && deploy\panel-start.bat"
rem
rem  参数可用 deploy\panel.env 同名的环境变量覆盖，
rem  也可以在运行前用 set 命令临时指定（见下方默认值）。
rem ============================================================================
setlocal

cd /d "%~dp0.."

if "%PORT%"=="" set PORT=3000
if "%OJ_HOST%"=="" set OJ_HOST=127.0.0.1
if "%OJ_MAX_JUDGES%"=="" set OJ_MAX_JUDGES=4
if "%NODE_ENV%"=="" set NODE_ENV=production
if "%TZ%"=="" set TZ=Asia/Shanghai

where node >nul 2>nul
if errorlevel 1 (
  echo [LCZOJ] 错误：找不到 node 命令。请先安装 Node.js v24（或 ^>= v22.5）。
  exit /b 1
)

echo [LCZOJ] 启动中：监听 %OJ_HOST%:%PORT%，数据目录 %CD%\data，并行判题 %OJ_MAX_JUDGES%
node server.js
endlocal
