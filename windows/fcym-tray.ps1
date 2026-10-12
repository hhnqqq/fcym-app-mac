﻿# fcym-tray.ps1 — 风车云马系统客户端（Windows 托盘版）
# 运行: powershell -ExecutionPolicy Bypass -File fcym-tray.ps1
# 依赖: .NET Framework (系统自带) + node (node\node.exe 或系统 PATH)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Continue'
$Script:SelfPath = $PSCommandPath
$Script:Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:Port = 8931
$Script:Home = Join-Path $env:APPDATA 'FcymClient'
$Script:NodeExe = $null
$Script:Proc = $null            # harness 子进程
$Script:UserStopped = $false
$Script:Status = $null
$Script:Nodes = @()
$Script:Current = $null

# ---------- node 可执行文件定位 ----------
function Find-Node {
    $bundled = Join-Path $Script:Dir 'node\node.exe'
    if (Test-Path $bundled) { return $bundled }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# ---------- HTTP 辅助 ----------
function Api-Get([string]$path) {
    try {
        # -NoProxy 仅 PS6+；WinINET 默认旁路 localhost，且我们的 PAC 也旁路 127.0.0.1
        return Invoke-RestMethod -Uri "http://127.0.0.1:$Script:Port$path" -TimeoutSec 3 -UseBasicParsing
    } catch { return $null }
}

# ---------- 子进程管理 ----------
function Ensure-Home { if (-not (Test-Path $Script:Home)) { New-Item -ItemType Directory -Path $Script:Home -Force | Out-Null } }

function Start-Harness {
    if ($Script:Proc -and -not $Script:Proc.HasExited) { return }
    $Script:UserStopped = $false
    $node = Find-Node
    if (-not $node) {
        Show-Balloon '未找到 node' '缺少 node\node.exe 且系统 PATH 中无 node。请将 node.exe 放入 node\ 目录，或安装 Node.js。'
        return
    }
    Ensure-Home
    # 首次运行：从本机 Edge 提取登录凭证
    $state = Join-Path $Script:Home 'state.json'
    if (-not (Test-Path $state)) {
        Show-Balloon '初始化' '正在从 Edge 提取登录凭证 ...'
        $p = Start-Process -FilePath $node -ArgumentList '"extract.mjs" "--state" "state.json"' -WorkingDirectory $Script:Dir -WindowStyle Hidden -PassThru -Wait
        if (-not (Test-Path $state)) {
            Show-Balloon '初始化失败' '无法从本机 Edge 提取凭证。请确认 Edge 已安装并登录过风车云马扩展；或从另一台电脑复制 state.json 到 FCYM_HOME 目录。'
            return
        }
    }
    $env:FCYM_HOME = $Script:Home
    $env:FCYM_SUPERVISED = '1'
    $out = Join-Path $Script:Home 'run.log'
    $err = Join-Path $Script:Home 'run.err.log'
    # cmd 包装便于单文件合并日志；taskkill /T 可杀整棵树
    $Script:Proc = Start-Process -FilePath "$env:ComSpec" `
        -ArgumentList "/c", "`"$node`" harness.mjs >> `"$out`" 2>> `"$err`"" `
        -WorkingDirectory $Script:Dir -WindowStyle Hidden -PassThru
    Show-Balloon '启动中' '正在登录并获取节点 ...'
}

function Stop-Harness([bool]$RevertProxy = $true) {
    $Script:UserStopped = $true
    if ($Script:Proc -and -not $Script:Proc.HasExited) {
        # 优先优雅停止（撤销系统代理）——Windows 无 SIGTERM，走 HTTP /stop
        $null = Api-Get '/stop'
        for ($i = 0; $i -lt 30; $i++) {
            if ($Script:Proc.HasExited) { break }
            Start-Sleep -Milliseconds 200
        }
        if (-not $Script:Proc.HasExited) {
            taskkill /T /F /PID $Script:Proc.Id 2>$null | Out-Null
        }
    }
    $Script:Proc = $null
    if ($RevertProxy) { Revert-SystemProxy }
}

function Revert-SystemProxy {
    # 兜底撤销（harness 正常退出时已自行撤销）
    try {
        reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f 2>$null | Out-Null
        & powershell.exe -NoProfile -NonInteractive -Command "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name W -Namespace P; [P.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [P.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null" | Out-Null
    } catch {}
}

# ---------- 状态刷新 ----------
$Script:FlagMap = @{
    'china' = [char]0xD83C + [char]0xDDE8 + [char]0xD83C + [char]0xDDF3
}
function Get-Flag([string]$flag) {
    if (-not $flag) { return '' }
    $f = $flag.ToLower()
    $table = @{
        'united states' = [string][char]0xD83C + [char]0xDDFA + [char]0xD83C + [char]0xDDF8
        'japan' = [string][char]0xD83C + [char]0xDDEF + [char]0xD83C + [char]0xDDF5
        'korea' = [string][char]0xD83C + [char]0xDDF0 + [char]0xD83C + [char]0xDDF7
        'hong kong' = [string][char]0xD83C + [char]0xDDED + [char]0xD83C + [char]0xDDF0
        'china' = [string][char]0xD83C + [char]0xDDE8 + [char]0xD83C + [char]0xDDF3
        'singapore' = [string][char]0xD83C + [char]0xDDF8 + [char]0xD83C + [char]0xDDEC
        'united kingdom' = [string][char]0xD83C + [char]0xDDEC + [char]0xD83C + [char]0xDDE7
        'germany' = [string][char]0xD83C + [char]0xDDE9 + [char]0xD83C + [char]0xDDEA
        'russian' = [string][char]0xD83C + [char]0xDDF7 + [char]0xD83C + [char]0xDDFA
        'india' = [string][char]0xD83C + [char]0xDDEE + [char]0xD83C + [char]0xDDF3
        'australia' = [string][char]0xD83C + [char]0xDDE6 + [char]0xD83C + [char]0xDDFA
        'world' = [string][char]0xD83C + [char]0xDDF0 + [char]0xD83C + [char]0xDDF5
    }
    foreach ($k in $table.Keys) { if ($f.Contains($k)) { return $table[$k] + ' ' } }
    return ''
}

function Refresh-Status {
    $Script:Status = Api-Get '/status'
    if ($Script:Status) { $nodesResp = Api-Get '/nodes'; if ($nodesResp) { $Script:Nodes = @($nodesResp.nodes); $Script:Current = $nodesResp.current } }
    Update-Menu
}

# ---------- UI ----------
function Show-Balloon([string]$title, [string]$msg) {
    try {
        $Script:NotifyIcon.BalloonTipTitle = $title
        $Script:NotifyIcon.BalloonTipText = $msg
        $Script:NotifyIcon.ShowBalloonTip(3000)
    } catch {}
}

function New-MenuItem([string]$text, [scriptblock]$onClick, [bool]$enabled = $true) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $text
    $item.Enabled = $enabled
    if ($onClick) { $item.Add_Click($onClick) }
    return $item
}

function Select-Node([int]$id) { $null = Api-Get "/select?id=$id"; Start-Sleep -Milliseconds 500; Refresh-Status }
function Set-Mode([string]$m) { $null = Api-Get "/mode?set=$m"; Start-Sleep -Milliseconds 500; Refresh-Status }

function Update-Menu {
    $menu = $Script:NotifyIcon.ContextMenuStrip
    $menu.SuspendLayout()
    $menu.Items.Clear()

    $running = ($Script:Proc -and -not $Script:Proc.HasExited)
    $ok = ($Script:Status -and $Script:Status.ok)
    $modeNames = @{ 'NModel' = '科学（白名单分流）'; 'AModel' = '全局（全部走节点）'; 'CModel' = '关闭' }
    $model = if ($Script:Status) { [string]$Script:Status.model } else { '' }
    $modeName = if ($modeNames[$model]) { $modeNames[$model] } else { $model }

    # 状态区
    $stText = if (-not $running) { '已停止' } elseif ($ok) { "运行中（$modeName 模式）" } else { '启动中…' }
    $menu.Items.Add((New-MenuItem "状态：$stText" $null $false)) | Out-Null
    if ($Script:Status -and $Script:Status.user) {
        $exp = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Script:Status.user.expireTime).ToLocalTime().ToString('yyyy-MM-dd')
        $menu.Items.Add((New-MenuItem "账号：$($Script:Status.user.email)（$exp 到期）" $null $false)) | Out-Null
    }
    if ($Script:Status -and $Script:Status.routeSample) {
        $menu.Items.Add((New-MenuItem "上游：$($Script:Status.routeSample)" $null $false)) | Out-Null
    }
    if ($Script:Status -and $Script:Status.stats) {
        $s = $Script:Status.stats
        $menu.Items.Add((New-MenuItem "分流：隧道 $($s.tunneled) · 直连 $($s.direct) · 错误 $($s.errors)" $null $false)) | Out-Null
    }
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # 运行模式
    $modeMenu = New-Object System.Windows.Forms.ToolStripMenuItem
    $modeMenu.Text = '运行模式'
    foreach ($m in @(@('NModel', '科学（白名单分流，默认）'), @('AModel', '全局（全部流量走节点）'), @('CModel', '关闭'))) {
        $mid = $m[0]
        $mi = New-MenuItem $m[1] $null $true
        $mi.Add_Click({ Set-Mode $mid }.GetNewClosure()) | Out-Null
        if ($model -eq $mid) { $mi.Checked = $true }
        $modeMenu.DropDownItems.Add($mi) | Out-Null
    }
    $menu.Items.Add($modeMenu) | Out-Null

    # 切换节点
    $nodeMenu = New-Object System.Windows.Forms.ToolStripMenuItem
    $nodeMenu.Text = '切换节点'
    $sorted = @($Script:Nodes | Sort-Object @{e = { if ($null -eq $_.ping -or $_.ping -lt 0 -or $_.ping -ge 1000) { 999999 } else { $_.ping } }})
    if ($sorted.Count -eq 0) {
        $nodeMenu.DropDownItems.Add((New-MenuItem '（启动后显示）' $null $false)) | Out-Null
    } else {
        foreach ($n in ($sorted | Select-Object -First 20)) {
            $ping = if ($null -ne $n.ping -and $n.ping -ge 0 -and $n.ping -lt 1000) { " $($n.ping)ms" } else { '' }
            $vip = if ($n.vip) { ' ★' } else { '' }
            $sel = if ($n.selected) { ' ✓' } else { '' }
            $mi = New-MenuItem "$(Get-Flag $n.flag)$($n.name)$ping$vip$sel" $null $true
            $nid = [int]$n.id
            $mi.Add_Click({ Select-Node $nid }.GetNewClosure()) | Out-Null
            $nodeMenu.DropDownItems.Add($mi) | Out-Null
        }
    }
    $menu.Items.Add($nodeMenu) | Out-Null

    $menu.Items.Add((New-MenuItem '签到（领免费时长）' { $null = Api-Get '/checkin'; Refresh-Status; Show-Balloon '签到' '已发送签到请求，几秒后状态更新' } $true)) | Out-Null
    $menu.Items.Add((New-MenuItem '打开状态页' { Start-Process "http://127.0.0.1:8931/status" } $true)) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # 开机自启动
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) '风车云马.lnk'
    $autoItem = New-MenuItem '开机自动启动' $null $true
    $autoItem.Checked = Test-Path $lnk
    $autoItem.Add_Click({
        $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) '风车云马.lnk'
        if (Test-Path $lnk) { Remove-Item $lnk -Force } 
        else {
            $sh = New-Object -ComObject WScript.Shell
            $sc = $sh.CreateShortcut($lnk)
            $sc.TargetPath = 'powershell.exe'
            $sc.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script:SelfPath`""
            $sc.WorkingDirectory = $Script:Dir
            $sc.WindowStyle = 7
            $sc.Save()
        }
        Refresh-Status
    }.GetNewClosure()) | Out-Null
    $menu.Items.Add($autoItem) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # 启动/停止/退出
    if ($running) {
        $menu.Items.Add((New-MenuItem '停止（撤销系统代理）' { Stop-Harness $true; Refresh-Status } $true)) | Out-Null
    } else {
        $menu.Items.Add((New-MenuItem '启动' { Start-Harness } $true)) | Out-Null
    }
    $menu.Items.Add((New-MenuItem '退出（撤销系统代理）' {
        Stop-Harness $true
        $Script:NotifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    } $true)) | Out-Null
    $menu.ResumeLayout()
}

# ---------- 图标（自绘蓝底"风"字圆标） ----------
function New-Icon([bool]$active) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $brush = if ($active) { New-Object System.Drawing.Drawing2D.LinearGradientBrush ((New-Object System.Drawing.Rectangle 0, 0, 32, 32)), ([System.Drawing.Color]::FromArgb(255, 30, 100, 235)), ([System.Drawing.Color]::FromArgb(255, 10, 60, 180)), 45 } 
              else { New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 150, 150, 150)) }
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(2, 2, 28, 28)
    $g.FillPath($brush, $path)
    $font = New-Object System.Drawing.Font 'Microsoft YaHei', 13, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('风', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 32, 32), $fmt)
    $g.Dispose()
    $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $ico
}

# ---------- 主循环 ----------
$Script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$Script:NotifyIcon.Icon = New-Icon $false
$Script:NotifyIcon.Text = '风车云马 · 系统客户端'
$Script:NotifyIcon.Visible = $true
$ctx = New-Object System.Windows.Forms.ContextMenuStrip
$Script:NotifyIcon.ContextMenuStrip = $ctx
$Script:NotifyIcon.Add_DoubleClick({ Start-Process 'http://127.0.0.1:8931/status' }.GetNewClosure())

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $running = ($Script:Proc -and -not $Script:Proc.HasExited)
    if (-not $running -and -not $Script:UserStopped) { Start-Harness }   # 崩溃自动拉起
    $newIcon = New-Icon ($running -and $Script:Status -and $Script:Status.ok)
    $old = $Script:NotifyIcon.Icon
    $Script:NotifyIcon.Icon = $newIcon
    try { $old.Dispose() } catch {}
    Refresh-Status
}.GetNewClosure())
$timer.Start()

Start-Harness
[System.Windows.Forms.Application]::Run()
$timer.Stop()
if ($Script:Proc -and -not $Script:Proc.HasExited) { Stop-Harness $true }
$Script:NotifyIcon.Dispose()
