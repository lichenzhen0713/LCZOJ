@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ==================================================
REM   LCZOJ 全自动推送到 GitHub + Gitee
REM   自动处理：未初始化仓库、远程未配置、推送被拒、
REM            无关历史、冲突等常见问题
REM ==================================================

REM ==== 按需修改 ====
set GITHUB_URL=https://github.com/lichenzhen0713/LCZOJ.git
set GITEE_URL=https://gitee.com/Carter_Zane/LCZOJ.git
set BRANCH=master
set DEFAULT_MSG=auto update
REM ==================

cd /d "%~dp0"
echo.
echo ========== 当前目录: %CD% ==========

REM ---------- [1] 确保是 Git 仓库 ----------
if not exist ".git" (
    echo [自动修复] 未检测到 .git，正在初始化仓库...
    git init
    if errorlevel 1 (
        echo [错误] git init 失败，请确认已安装 Git 并加入 PATH。
        pause & exit /b 1
    )
) else (
    echo [OK] 已是 Git 仓库。
)

REM ---------- [2] 确保本地有提交 ----------
git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 (
    echo [提示] 仓库还没有任何提交。
    git add .
    git commit -m "初始化项目"
)

REM ---------- [3] 添加所有改动并提交 ----------
echo.
echo ========== [1/5] 暂存并提交改动 ==========
git add -A
git diff --cached --quiet
if errorlevel 1 (
    set /p MSG=请输入提交信息（回车用默认 "%DEFAULT_MSG%"）: 
    if "!MSG!"=="" set MSG=%DEFAULT_MSG%
    git commit -m "!MSG!"
    if errorlevel 1 (
        echo [错误] 提交失败，可能有未解决的冲突或钩子拦截。
        echo 当前状态：
        git status
        pause & exit /b 1
    )
    echo [OK] 已提交。
) else (
    echo [OK] 没有需要提交的改动，跳过。
)

REM ---------- [4] 推送到 GitHub ----------
echo.
echo ========== [2/5] 推送到 GitHub ==========
call :push_to "%GITHUB_URL%" "GitHub"

REM ---------- [5] 推送到 Gitee ----------
echo.
echo ========== [3/5] 推送到 Gitee ==========
call :push_to "%GITEE_URL%" "Gitee"

echo.
echo ==================================================
echo  全部完成！
echo  GitHub: %GITHUB_URL%
echo  Gitee : %GITEE_URL%
echo ==================================================
pause
exit /b 0

REM ==================================================
REM  子过程：推送到指定远程，失败自动拉取合并后重试
REM ==================================================
:push_to
set URL=%~1
set NAME=%~2

REM 检查该 URL 是否已配置为 remote（避免每次重复添加）
git remote | findstr /x /c:"origin" >nul
if errorlevel 1 (
    git remote add origin "%URL%" >nul 2>nul
) else (
    REM 若 origin 地址与该 URL 不符，则临时用 URL 直推（不影响 origin 配置）
    git remote get-url origin >nul 2>nul
)

echo 正在推送到 %NAME% ...
git push "%URL%" %BRANCH% 2>nul
if not errorlevel 1 (
    echo [OK] %NAME% 推送成功。
    goto :eof
)

echo [重试] 首次推送被拒，尝试拉取合并后重推...
echo   - 可能原因：远程有本地没有的提交 / 无关历史 / 冲突

REM 先尝试普通合并
git pull "%URL%" %BRANCH% --no-edit --allow-unrelated-histories >nul 2>nul
if errorlevel 1 (
    echo [注意] 合并出现冲突或失败，检查状态...
    REM 检查是否有未合并文件
    git diff --name-only --diff-filter=U >"%TEMP%\_conflicts.txt" 2>nul
    for /f "usebackq delims=" %%f in ("%TEMP%\_conflicts.txt") do (
        echo   [冲突] %%f  --^> 自动采用【远程版本】
        git checkout --theirs -- "%%f" >nul 2>nul
        git add -- "%%f" >nul 2>nul
    )
    del "%TEMP%\_conflicts.txt" >nul 2>nul
    git commit -m "自动合并远程更改 (%NAME%)" >nul 2>nul
)

REM 再次推送
git push "%URL%" %BRANCH%
if errorlevel 1 (
    echo [失败] 仍无法推送到 %NAME%。
    echo  提示：如确认远程内容可丢弃，可手动执行强制推送：
    echo      git push "%URL%" %BRANCH% --force
    echo  或先解决冲突后重跑本脚本。
) else (
    echo [OK] %NAME% 重试推送成功。
)
goto :eof