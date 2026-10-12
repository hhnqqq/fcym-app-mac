# AGENTS.md — 风车云马系统级客户端：完整技术移交文档

> 本文档面向「接手维护/二次开发此项目的 AI agent 或工程师」。
> 目标：不接触原扩展开发者、不依赖原作者，独立理解并维护本客户端。

## 0. 这是什么

「风车云马」是一个 Edge 浏览器扩展（ID `cmlfpongefnmhijkolpgfjlbpplahcfi`，版本 3.88），
只在浏览器内生效（`chrome.proxy` API 设置 PAC）。本项目把它改造成 **系统级代理客户端**：

```
Edge LevelDB 提取登录凭证 ──┐
                            ▼
  Node 运行扩展原版 background.js（浏览器 API 全部 shim 掉）
        │ 自动完成：HTTP 拉配置 → WS 登录（账号 token）→ 服务端下发节点/域名白名单 → 生成 PAC
        ▼
  捕获 chrome.proxy.settings.set() 里的 PAC
        ▼
  本地转发代理 127.0.0.1:8931（按 PAC 逐域分流：白名单→加速节点，其余直连）
        ▼
  设置系统代理（macOS: networksetup / Windows: 注册表 AutoConfigURL + WinINET 广播）
```

**核心思路**：不重写协议，直接在 Node 里跑扩展自己的 background.js（复用它的登录、加密、
节点获取、PAC 生成逻辑），所以行为与官方扩展 100% 一致。

## 1. 逆向得到的协议细节（扩展怎么工作）

### 1.1 加密体系（background.js webpack bundle，模块 "69d9"/"1c38"）
- 对称加密：**XXTEA**（标准算法，delta=0x9E3779B9），密钥→base64
  - `encryptToString(str, key)` / `decryptToString(b64, key)`
- localStorage（扩展背景页）键名混淆：索引键存放在一个"键名映射"里，
  映射本身用 XXTEA(key="Windmill") 加密存于键 `it = XXTEA_encrypt("Windmill", "")`
- 每个索引 i 的实际键名：`map[CHARSET[i]]`，其中 CHARSET="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefhijklmnopqrstuvwxyz0123456789"
- 索引 i 的值用 XXTEA(key=CHARSET[i]) 加密。重要索引：
  - idx 2（'C'）= 运行模式：NModel(科学/白名单) / AModel(全局) / CModel(关闭)
  - idx 3（'D'）= 设备 UUID
  - idx 4（'E'）= 节点选择模式（true=自动）
  - idx 6（'G'）= **登录 token**（WS 会话凭证，会被服务端轮换，usr.t）
  - idx 14（'O'）= 手动选中的节点 id
  - `_UD`/`_SD` = 用户/系统域名列表（明文 JSON，不经索引混淆）
- 节点数据：WS 下发加密 blob → `JSON.parse(decryptToString(nodes, md5(I.toString()+j.toString()+T.toString())))`
  其中 I/j/T 是三个 PAC 混淆函数的源码 md5

### 1.2 通信流程（background.js 全自动完成，无需干预）
1. HTTP GET 配置端点（`st(u)` 轮换：localStorage idx12/21 的 cloud/api 列表 + 内置 3 个 ping2 兜底）
2. 配置响应按分隔符 `E2DoIU#R` 分两段（扩展 N() 的解析，`O(2)` 计算自字符串 "Em2EDooaI$U1#NR0" 的偶数位）：
   - **part0**：base64 → `{ios_min_ver..., key}` → 存 idx 9；`key` 用 **z 函数源码**（`function z(){...dsb...}`，
     从 background.js 正则提取）做 XXTEA 密钥解密 → `{web_site, ext_api:[ws端点...], web_api, app_api}`
   - **part1**：base32 → XXTEA(key="Em2EDooaI$U1#NR0") → 下一轮配置服务器 URL 列表 → 存 idx 21
3. **WS 连接** `ws://<ext_api>/<...>/wsEndpoint?token=...&lang=zh_CN&email=...&k=<uuid>&isFirst=...`
   - ⚠️ 服务器校验 `Origin: chrome-extension://<id>` 头 —— Node 端必须用 `ws` 包并注入该头（undici 自带 WebSocket 不行）
4. WS 收 initEXT → 配置+用户信息（usr.t 轮换 token，回写 localStorage idx6）
   showNodes → 节点列表（name/flag/vip/ipInfo/ping + 加密的 info）
   → `PAC_Setting.resetting()` → `chrome.proxy.settings.set({mode:'pac_script', pacScript:{data}})`
5. PAC 结构（自包含 JS）：域名 trie（白名单）→ `PROXY/HTTPS <节点>`，黑名单/其余 → DIRECT

### ⚠️ 1.2.1 端点轮换（重要！曾导致 2026-09-09 全天故障）
服务端会**不定期轮换 WS 端点**（如 ws://38.244.21.29:8070 → ws://154.64.234.67:8070/173.242.126.61）。
旧端点退役后握手会 **NPE 500**（Tomcat ConcurrentHashMap.put null，`WSConfigurator.modifyHandshake`）
或**无限挂起**（TCP 通但不响应 upgrade）。假 token 是快速 403——注意区分。
harness 已内置对策（勿删）：
- 启动前 `refreshEndpointsIfNeeded()`：拉配置服务器 → 对比 idx9 的 ext_api → 变化则写入 state.json
- `BrowserWS` 构造带 `handshakeTimeout: 10000`（防 CONNECTING 状态永久卡死扩展重连逻辑）
- 启动 90 秒未登录成功 → 再刷一次端点；若变化 `process.exit(1)`，由 App/托盘守护重启生效
- 扩展自己的 M() 配置拉取在我们的 XHR shim 下从未真正完成（原因未深究），不能依赖它刷新

### 1.3 节点代理的坑（重要！）
- 节点是 **caddy-forwardproxy**（probe_resistance 伪装成静态站）
- 未认证 CONNECT 返回 **404 而非 407**！认证用 `Proxy-Authorization: Basic`，
  凭据在 WS initEXT 下发的 extConfig.usr/pd 里（**不在 localStorage**，每次会话下发）
- 客户端通过捕获扩展注册的 `chrome.webRequest.onAuthRequired` 监听器来取凭据：
  调用 `listener({isProxy:true}, cb)` → cb({authCredentials:{username,password}})
- harness 的 connectUpstream：404/407 时取凭据重试；凭据轮换时自动重取

### 1.4 运行模式（PAC_Setting.changeModel，localStorage idx2）
| 模式 | 含义 | PAC 行为 |
|---|---|---|
| NModel | 科学（默认） | 白名单域名→节点，其余 DIRECT |
| AModel | 全局 | 全走节点（基础设施黑名单除外） |
| CModel | 关闭 | PAC=null，客户端撤销系统代理 |
（RModel = 服务端配置兜底的全局代理，不在用户选项里）

## 2. 文件地图

```
~/fcym-client/
├── harness.mjs        # 核心全部逻辑（跨平台）：shim + 运行 background.js + 本地代理 + 系统代理
├── extract.mjs        # 从 Edge LevelDB 提取 localStorage 种子（登录凭证）→ state.json
├── ext/               # 扩展原文件拷贝（js/background.js + manifest + _locales）—— harness 直接运行它
├── start.sh / stop.sh # macOS CLI
├── app/               # macOS 菜单栏 App（Swift，swiftc 编译）
│   ├── FcymClient.swift    # AppKit 菜单栏壳（进程管理/状态轮询/菜单）
│   └── build-app.sh        # 打包 .app（内置 node + harness）
├── windows/           # Windows 版
│   ├── fcym-tray.ps1       # 托盘应用（PowerShell WinForms NotifyIcon，零依赖）
│   ├── start/stop/status/run-tray.cmd
│   ├── build-windows.sh    # （在 mac 上跑）组装 windows 发布包
│   └── README-WINDOWS.md   # Windows 使用说明
├── AGENTS.md          # 本文档
└── README.md          # macOS 使用说明
```

## 3. harness.mjs 关键模块（~700 行）

| 部分 | 说明 |
|---|---|
| localStorage/sessionStorage shim | state.json 持久化（FCYM_HOME 目录） |
| chrome.* shim | proxy.settings.set = **PAC 捕获点**；webRequest.onAuthRequired = **代理凭据捕获点**；i18n 读 ext/_locales |
| XMLHttpRequest shim | 基于 fetch，给 axios 用（过滤非 latin1 头） |
| WebSocket 替换 | **必须用 ws 包**注入 Origin 头，否则服务器 403 |
| 本地代理 127.0.0.1:8931 | CONNECT 隧道 + 绝对地址转发；按 PAC 分流；环回保护；404/407 认证重试 |
| 系统代理 | macOS: networksetup；Windows: reg.exe + PowerShell InternetSetOption(39/37) |
| /status /nodes /select /mode /stop | 本地 HTTP 管理 API |
| 自愈 | PAC 恢复→重应用系统代理；扩展停用→撤销；30s 双向检查 |

HTTP API：
- `GET /status` → {ok, model, routeSample, user{email,expireTime}, stats{tunneled,direct,errors}, hasAuthCreds}
- `GET /nodes` → {nodes:[{id,name,flag,vip,ping,selected}...], current}
- `GET /select?id=N` → 切换节点
- `GET /mode?set=NModel|AModel|CModel` → 切换运行模式
- `GET /stop` → 优雅退出（撤销系统代理）

## 4. Windows 移植要点（已完成，改代码时注意）

- 系统代理：`HKCU\...\Internet Settings` 的 `AutoConfigURL` 值 + WinINET 广播
  （PowerShell P/Invoke InternetSetOption 39=SETTINGS_CHANGED 37=REFRESH，reg 后必须广播才即时生效）
- 无 SIGTERM：优雅停止靠 `GET /stop`；stop.cmd 兜底 taskkill + reg delete
- Edge localStorage 路径：`%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Local Storage\leveldb`
- classic-level 自带 win32-x64 prebuild，node_modules 直接复制可用
- 托盘：fcym-tray.ps1（.NET WinForms NotifyIcon，PS 5.1，UTF-8 BOM 必需）
- harness 已做平台分支（IS_WIN）；`node harness.mjs --dry-proxy` 打印各平台将执行的系统代理命令（自检用）

## 5. 调试技巧

- `FCYM_DEBUG=1 node harness.mjs` → 打印 WS 帧/XHR/内部状态（diag 每 5s：PAC/nodes/login/email）
- `node harness.mjs --dry-proxy` → 只打印系统代理命令不启动
- 服务端 WS 会话同 token 并发可能互踢（"NOT_LOGIN"/"FORCE_LOGOUT"→logout 流程）
- 节点 404 不一定是挂了：先查是否需要代理认证（看 run.log "获取到代理认证凭据"）
- PAC 在 FCYM_HOME/captured.pac；可手动 eval 验证 `FindProxyForURL` 行为
- state.json 里 idx6 是登录 token；被服务端轮换后自动回写（localStorage shim 持久化）

### ⚠️ 1.5 会员过期与签到（2026-09-20 实测）
**过期表现**：账号过期后登录正常、节点列表可见，但服务端下发的节点全部 `info` 为空
（hasInfo=false）→ generatePAC 只能生成 361 字节的全 DIRECT PAC → 系统代理"直连"。
诊断特征：`/status` pacSize 极小 + `/nodes` hasInfo 全 false + current 为 null。
**注意死锁**：getSelectNode 要求 info 非空才返回节点 → 客户端发 updateNode 不带 nodeId → 互锁。
**恢复方式**：
- 续费：扩展弹窗/官网（windmill2023.top），服务端恢复下发 info，下一会话自动恢复
- 签到领免费时长：`window.checkin()` = WS `{callback:"compareUser",action:"checkin",disptch:false}`，
  服务端返回 compareUser → W() 更新 usr.freeMins，随后 showNodes 带 info（仅免费节点）。
  harness 已暴露 `GET /checkin`；`GET /exchange?code=XXX` 为兑换码。菜单栏/托盘有"签到"入口。
- 免费节点（#8 美国/#18 新加坡 普速）质量很差（ECONNRESET/超时常见），非客户端问题。

## 6. 已知限制

- 两台设备同时跑（同 token）可能互踢；各自重新 extract 可用独立登录态
- SOCKS 上游未实现（目前节点都是 PROXY/HTTPS 型）
- Windows 下 FCYM_SUPERVISED 的 ppid===1 孤儿检测不可靠（Windows 孤儿 ppid 不变 1），
  依赖托盘的停止流程 + stop.cmd 兜底
- 扩展更新（版本号变化）后：重拷 ext/（manifest 版本号会被 background.js 校验，ext_min_ver）

## 7. 验证清单（改完跑一遍）

1. `node --check harness.mjs && node harness.mjs --dry-proxy`
2. 启动后 `curl -s localhost:8931/status` → ok:true、model、user.email 有值
3. `curl -s localhost:8931/nodes` → 节点列表有名称（美国1 等）
4. 系统代理已设置（Win: `reg query ... /v AutoConfigURL`；Mac: `scutil --proxy`）
5. `curl -x 127.0.0.1:8931 https://www.google.hk/` 走节点；`http://www.baidu.com/` 直连
6. 模式切换：/mode?set=CModel → 系统代理撤销；?set=NModel → 恢复
7. /stop → 进程退出且系统代理已撤销
