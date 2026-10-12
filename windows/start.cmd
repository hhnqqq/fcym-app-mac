@echo off
chcp 65001 >nul
title FCYM Client (console mode)
cd /d "%~dp0"

rem === node 定位：node\node.exe（自带）优先，其次系统 PATH ===
set "NODE="
if exist "node\node.exe" set "NODE=node\node.exe"
if not defined NODE (
  where node >nul 2>nul && set "NODE=node"
)
if not defined NODE (
  echo [错误] 未找到 Node.js：请将 node.exe 放入 node\ 目录，或安装 Node.js
  pause & exit /b 1
)

if not exist "%APPDATA%\FcymClient" mkdir "%APPDATA%\FcymClient"
if not exist "%APPDATA%\FcymClient\state.json" (
  echo [初始化] 首次运行：正在从本机 Edge 提取登录凭证 ...
  "%NODE%" extract.mjs --state "%APPDATA%\FcymClient\state.json"
  if errorlevel 1 (
    echo [错误] 提取失败：请确认 Edge 已安装并登录过风车云马扩展；
    echo        或从已配置的电脑复制 state.json 到 %%APPDATA%%\FcymClient\
    pause & exit /b 1
  )
)

set "FCYM_HOME=%APPDATA%\FcymClient"
echo [启动] 控制台模式（推荐用托盘：fcym-tray.ps1）。Ctrl+C 退出（自动撤销系统代理）。
"%NODE%" harness.mjs
