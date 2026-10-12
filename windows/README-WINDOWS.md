# 风车云马系统客户端 — Windows 版

把 Edge 扩展「风车云马」的加速从浏览器扩展到整个 Windows 系统（所有走系统代理的应用）。

## 安装（3 步）

1. **解压本文件夹到任意目录**（如 `D:\fcym-client`）
2. **准备登录凭证**（二选一）：
   - **本机 Edge 已装该扩展并登录过**（最简单）：首次运行会自动从 Edge 提取
   - **从另一台电脑复制**：把 Mac/另一台 Win 上的 `FCYM_HOME\state.json`
     （即 `%APPDATA%\FcymClient\state.json`）复制到本机的 `%APPDATA%\FcymClient\state.json`
3. **双击 `run-tray.cmd`** —— 托盘出现「风」蓝色图标即成功

> 若 `node\` 目录没有 node.exe 且系统未安装 Node.js：到 https://nodejs.org 装 LTS 版，
> 或从 https://npmmirror.com/mirrors/node/ 下载 win-x64 zip，解压 node.exe 放入 `node\` 目录。

## 日常使用

| 操作 | 方式 |
|---|---|
| 启动 | 双击 `run-tray.cmd`（托盘图标；开机自启在托盘菜单勾选） |
| 停止/退出 | 托盘菜单「停止」或「退出」（自动撤销系统代理） |
| 切换节点 | 托盘菜单「切换节点」（国旗+名称+延迟） |
| 运行模式 | 托盘菜单「运行模式」：科学（白名单）/ 全局 / 关闭 |
| 状态页 | 托盘菜单「打开状态页」或浏览器访问 http://127.0.0.1:8931/status |
| 命令行 | `status.cmd` 查看状态；`stop.cmd` 停止并撤销代理 |
| 调试/控制台模式 | `start.cmd`（前台运行，Ctrl+C 退出） |

## 目录说明

```
harness.mjs        核心引擎（跨平台，与 macOS 版同源）
extract.mjs        从本机 Edge 提取登录凭证（自动执行）
fcym-tray.ps1      托盘应用（PowerShell + .NET，系统自带零依赖）
node\              内置 Node.js 运行时（node.exe）
node_modules\      classic-level（读 Edge 数据）+ ws（WebSocket）
```

运行数据在 `%APPDATA%\FcymClient\`（state.json 登录态 / run.log 日志 / captured.pac）。

## 技术原理速览

- 在 Node 里跑扩展原版 background.js（浏览器 API shim），WS 登录取节点
- 本地代理 127.0.0.1:8931 按官方 PAC 逐域分流（白名单→节点，其余直连）
- 系统代理 = 注册表 `AutoConfigURL` + WinINET 广播（无需管理员权限，HKCU 用户级）
- 节点代理认证（404 伪装）自动处理；凭据轮换自动重取
- 详见 `AGENTS.md`（完整技术文档，供 AI agent/工程师接手维护）

## 常见问题

- **托盘没图标**：右键任务栏检查；或先跑 `start.cmd` 看控制台报错
- **提示提取失败**：本机 Edge 未登录过扩展 → 登录一次再跑，或从另一台电脑复制 state.json
- **系统代理异常**：跑 `stop.cmd` 清理；或手动删注册表
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `AutoConfigURL` 值
- **状态页打不开**：确认 `start.cmd`/托盘在运行（`status.cmd` 查看输出）
- **与浏览器扩展同账号同时运行**：可能互踢（同 token 会话），建议在 Edge 禁用扩展
- **代理只对"走系统代理"的应用生效**：绝大多数 GUI 应用支持；
  个别程序需自行设置 `127.0.0.1:8931` 为 HTTP 代理
