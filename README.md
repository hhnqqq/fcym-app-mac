# 风车云马系统级客户端

把「风车云马」Edge 扩展的加速能力从浏览器扩展到**整个系统**（所有走系统代理设置的 App）。

> **跨平台**：macOS（菜单栏 App + CLI）与 Windows（托盘程序 + CLI）共用同一套核心引擎
> `harness.mjs`（Node 运行扩展原版 background.js）。Windows 版见 `windows/` 目录，
> 完整打包在 `fcym-client-windows.zip`（桌面有副本，含内置 Node 运行时）。

## 平台支持

| 平台 | 界面 | 系统代理方式 |
| --- | --- | --- |
| macOS | 菜单栏 App（~/Applications/FcymClient.app） | `networksetup` PAC（免 sudo） |
| Windows | 托盘（fcym-tray.ps1，系统自带 .NET） | 注册表 `AutoConfigURL` + WinINET 广播（HKCU 用户级，免管理员） |

维护/二次开发请读 **AGENTS.md**（完整技术移交文档：协议细节、文件地图、调试技巧、验证清单）。

## macOS App（推荐）

**`~/Applications/FcymClient.app`** —— 原生菜单栏应用（ClashX 风格，不占 Dock）：

- 双击打开即可使用；菜单栏出现 🌀 图标
- 菜单功能：状态/账号/上游节点实时显示、**切换节点**（按延迟排序）、打开状态页、
  **开机自动启动**、停止（撤销系统代理）、退出（自动撤销系统代理）
- 内置 Node 运行时与全部依赖，自包含（117MB）；登录态独立存放在
  `~/Library/Application Support/FcymClient/`（state.json / run.log / captured.pac）
- 首次启动自动从 Edge 提取登录凭证（需已登录过扩展）；崩溃/被杀时自动撤销系统代理设置

重新打包（修改 harness 后）：

```bash
cd ~/fcym-client/app
swiftc -O -o FcymClient FcymClient.swift
./build-app.sh           # 输出 app/FcymClient.app
cp -R FcymClient.app ~/Applications/
```

## 获取扩展文件（首次运行必读）

出于版权原因，仓库**不包含**风车云马扩展的原文件（`ext/` 目录，见 .gitignore）。
本机 Edge 装过该扩展的，直接拷贝：

```bash
# macOS（zsh：把 * 换成扩展版本目录）
EXT=~/Library/Application\ Support/Microsoft\ Edge/Default/Extensions/cmlfpongefnmhijkolpgfjlbpplahcfi/*/
mkdir -p ext && cp -R "$EXT/js" "$EXT/manifest.json" "$EXT/_locales" ext/
npm install && ./start.sh
```

```powershell
# Windows（PowerShell）
$ext = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Extensions\cmlfpongefnmhijkolpgfjlbpplahcfi\*"
Copy-Item -Recurse "$ext\js", "$ext\manifest.json", "$ext\_locales" .\ext\
```

## 原理

1. **复用扩展自己的 background.js**（`ext/js/background.js`），在 Node 中以浏览器 API shim 运行它，
   自动完成登录（凭证取自 Edge localStorage 的 LevelDB）、WebSocket 会话、节点获取、PAC 生成
2. 本地转发代理 `127.0.0.1:8931`：按扩展生成的 PAC 逐域分流
   （白名单域名走加速节点，其余直连；节点切换实时生效；407 代理认证自动处理）
3. macOS 系统代理设为 `http://127.0.0.1:8931/proxy.pac`（免 sudo，全 GUI 应用生效）

分流逻辑、节点、域名白名单与浏览器扩展**完全一致**（跑的就是扩展原代码）。

## CLI 方式（开发调试用）

```bash
cd ~/fcym-client
npm install          # 首次：安装依赖 (classic-level, ws)
./start.sh           # 启动（首次自动从 Edge 提取凭证）
./stop.sh            # 停止并撤销系统代理
```

## 常用操作（App 与 CLI 通用 HTTP 接口）

```bash
curl -s http://127.0.0.1:8931/status            # 状态（含账号/统计）
curl -s http://127.0.0.1:8931/nodes             # 节点列表（名称/延迟/VIP）
curl -s 'http://127.0.0.1:8931/select?id=19'    # 切换节点
curl -s 'http://127.0.0.1:8931/mode?set=AModel' # 切换运行模式
```

**运行模式**（与扩展弹窗一致，App 菜单栏「运行模式」子菜单可切换）：

| 模式 | API 参数 | 行为 |
| --- | --- | --- |
| 科学（默认） | `NModel` | 白名单分流：加速列表内域名走节点，其余直连 |
| 全局 | `AModel` | 所有流量走节点（除节点自身/家宽黑名单） |
| 关闭 | `CModel` | 停用代理并自动撤销系统代理 |

切换后系统代理即时生效/撤销（30 秒自愈兜底）。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `app/FcymClient.swift` | 菜单栏 App 源码（AppKit，单文件，swiftc 编译） |
| `app/build-app.sh` | 打包脚本（组装 .app + 内置 Node + ad-hoc 签名） |
| `harness.mjs` | 核心：浏览器 API shim + 运行扩展 + PAC 捕获 + 本地转发代理 + 系统代理设置 |
| `extract.mjs` | 从 Edge LevelDB 提取扩展 localStorage（登录凭证等） |
| `ext/` | 扩展原文件（background.js / manifest / _locales） |
| `state.json` | CLI 运行状态（App 模式在 Application Support） |

## 注意事项

- **代理认证**：节点是 caddy-forwardproxy（probe_resistance 伪装），未认证 CONNECT 返回 404 而非 407；
  客户端捕获扩展 `onAuthRequired` 的凭据（`extConfig.usr/pd`）自动附加 `Proxy-Authorization`，
  凭据轮换时自动重取。
- **建议同时禁用 Edge 里的风车云马扩展**：客户端与扩展用同一账号登录，
  两个 WebSocket 会话并发可能互踢；代理已由客户端系统级接管。
- 白名单域名（系统 + 用户添加的）通过 WS 自动同步，无需重启。
- App 与 CLI 不要同时运行（端口 8931 冲突，后启动方会自动退出）。
- 仅有 PAC 意识的程序走系统代理：GUI 应用绝大多数支持；终端程序用环境变量
  （`export https_proxy=http://127.0.0.1:8931`）。
- 账号到期后扩展逻辑会清空 PAC，客户端检测到后同样撤销系统代理。

