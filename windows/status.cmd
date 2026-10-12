@echo off
chcp 65001 >nul
curl -s http://127.0.0.1:8931/status
echo.
curl -s http://127.0.0.1:8931/nodes
