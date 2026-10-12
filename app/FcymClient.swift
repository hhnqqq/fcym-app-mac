// FcymClient.swift — 风车云马系统级客户端（菜单栏 App）
// 编译: swiftc -O FcymClient.swift -o FcymClient
import AppKit
import Foundation
import ServiceManagement

// MARK: - 常量
let FCYM_PORT = 8931
let STATUS_URL = URL(string: "http://127.0.0.1:\(FCYM_PORT)/status")!
let NODES_URL = URL(string: "http://127.0.0.1:\(FCYM_PORT)/nodes")!

func appSupportHome() -> URL {
    let home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FcymClient", isDirectory: true)
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    return home
}

// MARK: - 模型
struct Status: Codable {
    var ok: Bool?
    var pacReady: Bool?
    var routeSample: String?
    var model: String?
    var hasAuthCreds: Bool?
    var user: User?
    var stats: Stats?
}
struct User: Codable {
    var email: String?
    var expireTime: Double?
    var freeMins: Int?
}
struct Stats: Codable {
    var conns: Int?
    var tunneled: Int?
    var direct: Int?
    var errors: Int?
}
struct NodesResp: Codable {
    var nodes: [Node]?
    var current: NodeRef?
}
struct Node: Codable {
    var id: Int?
    var name: String?
    var shortName: String?
    var flag: String?
    var vip: Bool?
    var enabled: Bool?
    var ping: Int?
    var selected: Bool?
}
struct NodeRef: Codable {
    var id: Int?
    var name: String?
}

/// 国旗资源名 -> emoji（节点数据里的 flag 如 "United States.png"）
func flagEmoji(_ flag: String?) -> String {
    guard let f = flag?.lowercased(), !f.isEmpty else { return "" }
    let table: [(String, String)] = [
        ("united states", "🇺🇸"), ("usa", "🇺🇸"), ("japan", "🇯🇵"), ("korea", "🇰🇷"),
        ("hong kong", "🇭🇰"), ("taiwan", "🇹🇼"), ("singapore", "🇸🇬"), ("united kingdom", "🇬🇧"),
        ("england", "🇬🇧"), ("germany", "🇩🇪"), ("france", "🇫🇷"), ("netherlands", "🇳🇱"),
        ("canada", "🇨🇦"), ("australia", "🇦🇺"), ("new zealand", "🇳🇿"), ("malaysia", "🇲🇾"),
        ("thailand", "🇹🇭"), ("philippines", "🇵🇭"), ("india", "🇮🇳"), ("turkey", "🇹🇷"),
        ("russia", "🇷🇺"), ("brazil", "🇧🇷"), ("argentina", "🇦🇷"), ("italy", "🇮🇹"),
        ("spain", "🇪🇸"), ("switzerland", "🇨🇭"), ("sweden", "🇸🇪"), ("norway", "🇳🇴"),
        ("finland", "🇫🇮"), ("denmark", "🇩🇰"), ("austria", "🇦🇹"), ("belgium", "🇧🇪"),
        ("ireland", "🇮🇪"), ("poland", "🇵🇱"), ("czech", "🇨🇿"), ("romania", "🇷🇴"),
        ("ukraine", "🇺🇦"), ("israel", "🇮🇱"), ("united arab emirates", "🇦🇪"), ("vietnam", "🇻🇳"),
        ("indonesia", "🇮🇩"), ("mexico", "🇲🇽"), ("chile", "🇨🇱"), ("south africa", "🇿🇦"),
        ("china", "🇨🇳"), ("macau", "🇲🇴"), (" kazakhstan", "🇰🇿"),
    ]
    for (key, emoji) in table where f.contains(key) { return emoji }
    return ""
}

// MARK: - 网络层
func httpGet(_ url: URL, timeout: Double = 3, completion: @escaping (Data?) -> Void) {
    var req = URLRequest(url: url)
    req.timeoutInterval = timeout
    URLSession.shared.dataTask(with: req) { data, _, _ in
        completion(data)
    }.resume()
}

// MARK: - Harness 子进程管理
final class HarnessProcess {
    var process: Process?
    private(set) var userStopped = false
    private var failures = 0
    private var restartTimer: Timer?
    private var logHandle: FileHandle?
    private let nodeBin: URL
    private let harnessDir: URL
    private let home: URL

    init() {
        let bundle = Bundle.main
        let res = bundle.resourcePath ?? bundle.bundlePath
        nodeBin = URL(fileURLWithPath: res).appendingPathComponent("node")
        harnessDir = URL(fileURLWithPath: res).appendingPathComponent("harness", isDirectory: true)
        home = appSupportHome()
    }

    var isRunning: Bool { process?.isRunning ?? false }

    func start() {
        guard !isRunning else { return }
        userStopped = false

        // 首次运行：从 Edge 提取登录凭证
        let stateFile = home.appendingPathComponent("state.json")
        if !FileManager.default.fileExists(atPath: stateFile.path) {
            let extract = Process()
            extract.executableURL = nodeBin
            extract.arguments = [harnessDir.appendingPathComponent("extract.mjs").path, "--state", stateFile.path]
            extract.environment = ProcessInfo.processInfo.environment
            extract.standardOutput = Pipe()
            extract.standardError = Pipe()
            try? extract.run()
            extract.waitUntilExit()
            if !FileManager.default.fileExists(atPath: stateFile.path) {
                NSAlert(message: "初始化失败：无法从 Edge 提取登录凭证。\n请确认已安装并登录过风车云马 Edge 扩展后重试。")
                return
            }
        }

        let p = Process()
        p.executableURL = nodeBin
        p.arguments = [harnessDir.appendingPathComponent("harness.mjs").path]
        p.currentDirectoryURL = harnessDir
        var env = ProcessInfo.processInfo.environment
        env["FCYM_HOME"] = home.path
        env["FCYM_SUPERVISED"] = "1"
        p.environment = env
        p.standardOutput = logPipe()
        p.standardError = logPipe()
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.handleTermination(code: proc.terminationStatus) }
        }
        do { try p.run() } catch {
            NSAlert(message: "启动 harness 失败: \(error.localizedDescription)")
            return
        }
        process = p
        // 稳定运行一段时间后重置退避计数（避免长期运行后偶发一次崩溃就退避很久）
        DispatchQueue.global().asyncAfter(deadline: .now() + 600) { [weak self] in
            DispatchQueue.main.async { self?.failures = 0 }
        }
    }

    private func logPipe() -> Pipe {
        let pipe = Pipe()
        let path = home.appendingPathComponent("run.log").path
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile()
            logHandle = h
            pipe.fileHandleForReading.readabilityHandler = { fh in
                let d = fh.availableData
                if d.isEmpty { fh.readabilityHandler = nil } else { self.logHandle?.write(d) }
            }
        }
        return pipe
    }

    private func handleTermination(code: Int32) {
        logHandle?.closeFile()
        logHandle = nil
        process = nil
        NotificationCenter.default.post(name: .harnessStateChanged, object: nil)
        guard !userStopped else { return }
        // 永不放弃：指数退避（4s→8s→16s→32s→60s 封顶），网络/服务端抖动后总能自愈
        failures += 1
        let delay = min(4.0 * pow(2.0, Double(failures - 1)), 60.0)
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.start()
        }
    }

    /// SIGTERM 优雅停止（harness 会在退出前撤销系统代理）
    func stop(revertProxy: Bool = true) {
        userStopped = true
        restartTimer?.invalidate()
        guard let p = process, p.isRunning else { return }
        p.terminate()  // SIGTERM
        let deadline = Date().addingTimeInterval(6)
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if p.isRunning { p.interrupt() }
        process = nil
        if revertProxy { Self.revertSystemProxy() }
    }

    static func revertSystemProxy() {
        for svc in ["Wi-Fi", "Thunderbolt Bridge", "Ethernet", "USB 10/100/1000 LAN", "Bluetooth PAN"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
            p.arguments = ["-setautoproxystate", svc, "off"]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run(); p.waitUntilExit()
        }
    }
}
extension Notification.Name {
    static let harnessStateChanged = Notification.Name("harnessStateChanged")
}

// MARK: - App
final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var harness = HarnessProcess()
    var pollTimer: Timer?
    var status: Status?
    var nodes: [Node] = []
    var currentNode: NodeRef?
    var menuNodesItem: NSMenuItem!
    var menuStatusLine: NSMenuItem!
    var menuNodeLine: NSMenuItem!
    var menuStatsLine: NSMenuItem!
    var menuAccountLine: NSMenuItem!
    var menuToggleItem: NSMenuItem!

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🌀"
        }
        buildMenu()
        rebuildDynamicMenu()

        NotificationCenter.default.addObserver(forName: .harnessStateChanged, object: nil, queue: .main) { [weak self] _ in
            self?.rebuildDynamicMenu()
        }

        harness.start()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    func applicationWillTerminate(_ n: Notification) {
        harness.stop(revertProxy: true)
    }

    // MARK: 菜单
    func buildMenu() {
        let menu = NSMenu()
        let title = NSMenuItem(title: "风车云马 · 系统客户端", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        menuStatusLine = NSMenuItem(title: "状态：…", action: nil, keyEquivalent: "")
        menuStatusLine.isEnabled = false
        menu.addItem(menuStatusLine)
        menuAccountLine = NSMenuItem(title: "账号：…", action: nil, keyEquivalent: "")
        menuAccountLine.isEnabled = false
        menu.addItem(menuAccountLine)
        menuNodeLine = NSMenuItem(title: "节点：…", action: nil, keyEquivalent: "")
        menuNodeLine.isEnabled = false
        menu.addItem(menuNodeLine)
        menuStatsLine = NSMenuItem(title: "分流：…", action: nil, keyEquivalent: "")
        menuStatsLine.isEnabled = false
        menu.addItem(menuStatsLine)
        menu.addItem(.separator())

        // 运行模式：科学(NModel/白名单分流) 全局(AModel/全走节点) 关闭(CModel)
        let modeSub = NSMenuItem(title: "运行模式", action: nil, keyEquivalent: "")
        let modeMenu = NSMenu()
        let modes: [(String, String, String)] = [
            ("NModel", "科学（白名单分流，默认）", "仅加速列表内的网站，其余直连"),
            ("AModel", "全局（全部流量走节点）", "所有网站都经节点转发"),
            ("CModel", "关闭", "停用系统代理"),
        ]
        for (mid, label, tip) in modes {
            let item = NSMenuItem(title: label, action: #selector(setMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mid
            item.toolTip = tip
            modeMenu.addItem(item)
        }
        modeSub.submenu = modeMenu
        menu.addItem(modeSub)

        let nodesSub = NSMenuItem(title: "切换节点", action: nil, keyEquivalent: "")
        let subMenu = NSMenu()
        let refreshItem = NSMenuItem(title: "刷新列表", action: #selector(refreshNodes), keyEquivalent: "")
        refreshItem.target = self
        subMenu.addItem(refreshItem)
        subMenu.addItem(.separator())
        nodesSub.submenu = subMenu
        menuNodesItem = nodesSub
        menu.addItem(nodesSub)

        let checkin = NSMenuItem(title: "签到（领免费时长）", action: #selector(doCheckin), keyEquivalent: "")
        checkin.target = self
        menu.addItem(checkin)
        let statusPage = NSMenuItem(title: "打开状态页", action: #selector(openStatusPage), keyEquivalent: "")
        statusPage.target = self
        menu.addItem(statusPage)
        menu.addItem(.separator())

        let autoLaunch = NSMenuItem(title: "开机自动启动", action: #selector(toggleAutoLaunch), keyEquivalent: "")
        autoLaunch.target = self
        autoLaunch.state = Self.autoLaunchEnabled() ? .on : .off
        menu.addItem(autoLaunch)
        menu.addItem(.separator())

        menuToggleItem = NSMenuItem(title: "停止", action: #selector(toggleHarness), keyEquivalent: "")
        menuToggleItem.target = self
        menu.addItem(menuToggleItem)

        let quit = NSMenuItem(title: "退出（撤销系统代理）", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    func rebuildDynamicMenu() {
        let running = harness.isRunning
        statusItem.button?.title = running ? "🌀" : "◍"
        let model = status?.model ?? ""
        let modeName = ["NModel": "科学", "AModel": "全局", "CModel": "关闭"][model] ?? nil
        if running {
            let base = (status?.ok == true) ? "状态：运行中 ✓" : "状态：启动中…"
            menuStatusLine.title = modeName.map { "\(base)（\($0)模式）" } ?? ((status?.ok == true) ? "状态：运行中 ✓ 全局代理已生效" : "状态：启动中…（等待节点/登录）")
        } else {
            menuStatusLine.title = "状态：已停止"
        }
        menuToggleItem.title = running ? "停止（撤销系统代理）" : "启动"
        // 运行模式勾选
        if let msub = statusItem.menu?.items.first(where: { $0.title == "运行模式" })?.submenu, msub.items.count == 3 {
            msub.items[0].state = (model == "NModel") ? .on : .off
            msub.items[1].state = (model == "AModel") ? .on : .off
            msub.items[2].state = (model == "CModel") ? .on : .off
        }
        // 节点子菜单
        if let sub = menuNodesItem.submenu {
            while sub.items.count > 2 { sub.removeItem(at: 2) }
            let sorted = nodes.sorted {
                let l = ($0.ping == nil || $0.ping == -1 || $0.ping == 1000) ? Int.max / 2 + ($0.ping ?? 0) : $0.ping!
                let r = ($1.ping == nil || $1.ping == -1 || $1.ping == 1000) ? Int.max / 2 + ($1.ping ?? 0) : $1.ping!
                return l < r
            }
            for n in sorted.prefix(20) {
                guard let id = n.id else { continue }
                let name = n.name ?? n.shortName ?? (n.flag ?? "")
                let ping = (n.ping != nil && n.ping! >= 0 && n.ping! < 1000) ? " \((n.ping!))ms" : ""
                let vip = (n.vip == true) ? " ★" : ""
                let title = "\(flagEmoji(n.flag)) \(name)\(ping)\(vip)"
                let item = NSMenuItem(title: title, action: #selector(selectNode(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = id
                item.state = (n.selected == true || currentNode?.id == id) ? .on : .off
                sub.addItem(item)
            }
            if nodes.isEmpty {
                let item = NSMenuItem(title: "（启动后显示）", action: nil, keyEquivalent: "")
                item.isEnabled = false
                sub.addItem(item)
            }
        }
    }

    // MARK: 数据刷新
    @objc func refresh() {
        httpGet(STATUS_URL) { [weak self] data in
            DispatchQueue.main.async {
                guard let self else { return }
                if let data {
                    self.status = try? JSONDecoder().decode(Status.self, from: data)
                    if let u = self.status?.user {
                        let email = (u.email ?? "?")
                        let exp = u.expireTime.map { Self.fmtDate($0) } ?? "-"
                        self.menuAccountLine.title = "账号：\(email)（\(exp) 到期）"
                    }
                    if let st = self.status?.stats {
                        self.menuStatsLine.title = "分流：隧道 \(st.tunneled ?? 0) · 直连 \(st.direct ?? 0) · 错误 \(st.errors ?? 0)"
                    }
                    if let r = self.status?.routeSample, let host = Self.hostOf(r) {
                        let name = self.currentNode?.name ?? "—"
                        let fl = self.nodes.first(where: { $0.id == self.currentNode?.id }).flatMap { flagEmoji($0.flag) } ?? ""
                        self.menuNodeLine.title = "节点：\(fl) \(name)  (\(host))"
                    }
                } else {
                    self.status = nil
                    if !self.harness.isRunning {
                        self.menuAccountLine.title = "账号：-"
                        self.menuStatsLine.title = "分流：-"
                        self.menuNodeLine.title = "上游：-"
                    }
                }
                self.rebuildDynamicMenu()
            }
        }
        guard harness.isRunning else { return }
        httpGet(NODES_URL) { [weak self] data in
            DispatchQueue.main.async {
                guard let self else { return }
                    if let data, let resp = try? JSONDecoder().decode(NodesResp.self, from: data) {
                        self.nodes = resp.nodes ?? []
                        self.currentNode = resp.current
                        if let cur = resp.current, let r = self.status?.routeSample, let host = Self.hostOf(r) {
                            let fl = self.nodes.first(where: { $0.id == cur.id }).flatMap { flagEmoji($0.flag) } ?? ""
                            self.menuNodeLine.title = "节点：\(fl) \(cur.name ?? "—")  (\(host))"
                        }
                    }
                self.rebuildDynamicMenu()
            }
        }
    }

    @objc func refreshNodes() { refresh() }

    static func fmtDate(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
    static func hostOf(_ s: String) -> String? {
        let m = s.split(whereSeparator: { " ;".contains($0) })
        guard let second = m.first(where: { $0.contains(".") }) else { return s }
        return String(second.split(separator: " ").last ?? second)
    }

    // MARK: 动作
    @objc func setMode(_ sender: NSMenuItem) {
        guard let mid = sender.representedObject as? String else { return }
        let url = URL(string: "http://127.0.0.1:\(FCYM_PORT)/mode?set=\(mid)")!
        httpGet(url) { _ in DispatchQueue.main.async { self.refresh() } }
    }
    @objc func selectNode(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? Int else { return }
        let url = URL(string: "http://127.0.0.1:\(FCYM_PORT)/select?id=\(id)")!
        httpGet(url) { _ in DispatchQueue.main.async { self.refresh() } }
    }
    @objc func doCheckin() {
        httpGet(URL(string: "http://127.0.0.1:\(FCYM_PORT)/checkin")!) { data in
            DispatchQueue.main.async {
                if let d = data, (String(data: d, encoding: .utf8)?.contains("\"ok\":true") ?? false) {
                    self.refresh()
                } else {
                    self.menuAccountLine.title = "账号：签到失败（未登录或已签过）"
                }
            }
        }
    }
    @objc func openStatusPage() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(FCYM_PORT)/status")!)
    }
    @objc func toggleHarness() {
        if harness.isRunning {
            harness.stop(revertProxy: true)
            status = nil
            nodes = []
        } else {
            harness.start()
        }
        rebuildDynamicMenu()
    }
    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: 开机自启
    static func autoLaunchEnabled() -> Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .enabled
        }
        return false
    }
    @objc func toggleAutoLaunch() {
        if Self.autoLaunchEnabled() {
            try? SMAppService.mainApp.unregister()
        } else {
            try? SMAppService.mainApp.register()
        }
        if let item = statusItem.menu?.item(withTitle: "开机自动启动") {
            item.state = Self.autoLaunchEnabled() ? .on : .off
        }
    }
}

func NSAlert(message: String) {
    let a = NSAlert()
    a.messageText = message
    a.runModal()
}

// MARK: - main
// SIGTERM/SIGINT 也走优雅退出（撤销系统代理）
signal(SIGTERM, SIG_IGN)
let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSrc.setEventHandler { NSApp.terminate(nil) }
termSrc.resume()
signal(SIGINT, SIG_IGN)
let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSrc.setEventHandler { NSApp.terminate(nil) }
intSrc.resume()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // 菜单栏 App，不占 Dock
app.run()
