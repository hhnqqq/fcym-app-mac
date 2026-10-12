@echo off
chcp 65001 >nul
rem === 优雅停止：先 HTTP /stop，失败则强杀并直接撤销系统代理 ===
curl -s --max-time 3 http://127.0.0.1:8931/stop >nul 2>nul
timeout /t 3 /nobreak >nul
taskkill /F /IM node.exe /FI "WINDOWTITLE eq FCYM*" >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*harness.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f >nul 2>nul
powershell -NoProfile -NonInteractive -Command "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name W -Namespace P; [P.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [P.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null" >nul 2>nul
echo [完成] 已停止并撤销系统代理
