import AppKit
import Foundation

struct VisionConfig: Codable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var prompt: String
}

final class VisionApp: NSObject, NSApplicationDelegate {
    private let lockPath = "/tmp/claude-code-vision.lock"
    private var lockFileDescriptor: Int32 = -1
    private let statusItem = NSStatusBar.system.statusItem(withLength: 28)
    private let home = FileManager.default.homeDirectoryForCurrentUser.path
    private var timer: Timer?
    private var proxyProcess: Process?
    private var statusMenuItem: NSMenuItem?
    private var settingsWindow: NSWindow?
    private var providerPopup: NSPopUpButton?
    private var baseUrlField: NSTextField?
    private var keyField: NSSecureTextField?
    private var modelField: NSTextField?
    private var promptField: NSTextField?

    private lazy var ctlPath = "\(home)/.claude/vision-proxy/visionctl.sh"
    private lazy var logPath = "\(home)/.claude/vision-proxy.log"
    private lazy var visionConfigPath = "\(home)/.claude/vision-proxy/vision-model.json"
    private lazy var runtimePath = Bundle.main.resourcePath.map { "\($0)/vision-proxy" } ?? ""
    private lazy var menuIcon: NSImage? = {
        guard let image = NSImage(named: "MenuBarIcon") else {
            return nil
        }
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard acquireSingleInstanceLock() else {
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        installBundledRuntimeIfNeeded()
        installEditMenu()
        buildMenu()
        configureButton()
        setServiceStatus(running: true, text: "状态：识图服务开启中")
        startForegroundService()
        refreshStatus()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.refreshStatus()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refreshStatus()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopForegroundService()
        releaseSingleInstanceLock()
    }

    private func acquireSingleInstanceLock() -> Bool {
        lockFileDescriptor = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        if lockFileDescriptor < 0 {
            return true
        }
        if flock(lockFileDescriptor, LOCK_EX | LOCK_NB) != 0 {
            close(lockFileDescriptor)
            lockFileDescriptor = -1
            return false
        }
        ftruncate(lockFileDescriptor, 0)
        if let pidData = "\(ProcessInfo.processInfo.processIdentifier)\n".data(using: .utf8) {
            pidData.withUnsafeBytes { buffer in
                _ = write(lockFileDescriptor, buffer.baseAddress, buffer.count)
            }
        }
        return true
    }

    private func releaseSingleInstanceLock() {
        if lockFileDescriptor >= 0 {
            flock(lockFileDescriptor, LOCK_UN)
            close(lockFileDescriptor)
            lockFileDescriptor = -1
            try? FileManager.default.removeItem(atPath: lockPath)
        }
    }

    private func installBundledRuntimeIfNeeded() {
        guard !runtimePath.isEmpty else {
            return
        }
        let fileManager = FileManager.default
        let proxyDir = "\(home)/.claude/vision-proxy"
        let bundledProxy = "\(runtimePath)/proxy.mjs"
        let bundledCtl = "\(runtimePath)/visionctl.sh"
        guard fileManager.fileExists(atPath: bundledProxy),
              fileManager.fileExists(atPath: bundledCtl) else {
            return
        }

        try? fileManager.createDirectory(
            atPath: proxyDir,
            withIntermediateDirectories: true
        )

        let files = [
            "proxy.mjs",
            "visionctl.sh",
            "package.json",
            "package-lock.json"
        ]
        for file in files {
            let source = "\(runtimePath)/\(file)"
            let destination = "\(proxyDir)/\(file)"
            guard fileManager.fileExists(atPath: source) else {
                continue
            }
            try? fileManager.removeItem(atPath: destination)
            try? fileManager.copyItem(atPath: source, toPath: destination)
        }

        let exampleConfig = "\(runtimePath)/vision-model.example.json"
        let runtimeConfig = "\(proxyDir)/vision-model.json"
        if !fileManager.fileExists(atPath: runtimeConfig),
           fileManager.fileExists(atPath: exampleConfig) {
            try? fileManager.copyItem(atPath: exampleConfig, toPath: runtimeConfig)
        }

        try? fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: "\(proxyDir)/visionctl.sh"
        )

        if !fileManager.fileExists(atPath: "\(proxyDir)/node_modules/undici") {
            installNodeDependencies(proxyDir: proxyDir)
        }
    }

    private func installNodeDependencies(proxyDir: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["npm", "install", "--omit=dev"]
        process.currentDirectoryURL = URL(fileURLWithPath: proxyDir)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let statusLine = NSMenuItem(title: "状态：启动中", action: nil, keyEquivalent: "")
        statusMenuItem = statusLine
        menu.addItem(statusLine)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "启动识图服务", action: #selector(startService), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "停止识图服务", action: #selector(stopService), keyEquivalent: "x"))
        menu.addItem(NSMenuItem(title: "重启识图服务", action: #selector(restartService), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "识图模型设置...", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "刷新状态", action: #selector(refreshStatusAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开日志", action: #selector(openLog), keyEquivalent: "l"))
        menu.addItem(NSMenuItem(title: "复制诊断信息", action: #selector(copyDiagnostics), keyEquivalent: "d"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        self.statusItem.menu = menu
    }

    private func installEditMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "退出 ClaudeCode-Vision", action: #selector(quit), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(NSMenuItem(title: "撤销", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApp.mainMenu = mainMenu
    }

    private func configureButton() {
        guard let button = statusItem.button else {
            return
        }
        button.imagePosition = .imageOnly
        button.bezelStyle = .texturedRounded
        button.setButtonType(.momentaryPushIn)
        button.title = ""
        button.image = makeStatusImage(active: false)
        button.toolTip = "Claude Code 识图服务"
    }

    @objc private func startService() {
        startForegroundService()
        refreshStatus()
    }

    @objc private func stopService() {
        stopForegroundService()
        refreshStatus()
    }

    @objc private func restartService() {
        stopForegroundService()
        startForegroundService()
        refreshStatus()
    }

    @objc private func refreshStatusAction() {
        refreshStatus()
    }

    @objc private func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc private func copyDiagnostics() {
        let diagnostics = runCtl("doctor").trimmingCharacters(in: .whitespacesAndNewlines)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(diagnostics.isEmpty ? "诊断信息为空" : diagnostics, forType: .string)
        setServiceStatus(
            running: isServiceRunning() && isVisionModelConfigured(),
            text: "状态：诊断信息已复制"
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            self?.refreshStatus()
        }
    }

    @objc private func openSettings() {
        if let window = settingsWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 300),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "识图模型设置"
        window.center()

        let config = loadVisionConfig()
        let providerPopup = NSPopUpButton(frame: NSRect(x: 150, y: 240, width: 300, height: 28))
        providerPopup.addItems(withTitles: ["gemini", "openai-compatible"])
        providerPopup.selectItem(withTitle: config.provider)

        let baseUrlField = NSTextField(frame: NSRect(x: 150, y: 198, width: 320, height: 24))
        baseUrlField.stringValue = config.baseUrl
        baseUrlField.placeholderString = "例如：https://api.openai.com/v1 或 Gemini Base URL"

        let keyField = NSSecureTextField(frame: NSRect(x: 150, y: 156, width: 320, height: 24))
        keyField.stringValue = config.apiKey

        let modelField = NSTextField(frame: NSRect(x: 150, y: 114, width: 320, height: 24))
        modelField.stringValue = config.model
        modelField.placeholderString = "例如：gemini-2.5-flash、gpt-4o-mini"

        let promptField = NSTextField(frame: NSRect(x: 150, y: 72, width: 320, height: 24))
        promptField.stringValue = config.prompt
        promptField.placeholderString = "可选：自定义图片描述提示词"

        let saveButton = NSButton(frame: NSRect(x: 360, y: 24, width: 110, height: 32))
        saveButton.title = "保存"
        saveButton.bezelStyle = .rounded
        saveButton.target = self
        saveButton.action = #selector(saveSettings(_:))

        self.providerPopup = providerPopup
        self.baseUrlField = baseUrlField
        self.keyField = keyField
        self.modelField = modelField
        self.promptField = promptField

        let content = NSView(frame: window.contentView!.bounds)
        addLabel("供应商", x: 32, y: 244, to: content)
        addLabel("接口地址", x: 32, y: 202, to: content)
        addLabel("API Key", x: 32, y: 160, to: content)
        addLabel("模型", x: 32, y: 118, to: content)
        addLabel("提示词", x: 32, y: 76, to: content)
        for view in [providerPopup, baseUrlField, keyField, modelField, promptField, saveButton] {
            content.addSubview(view)
        }
        window.contentView = content
        window.isReleasedWhenClosed = false
        settingsWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func saveSettings(_ sender: NSButton) {
        guard let providerPopup,
              let baseUrlField,
              let keyField,
              let modelField,
              let promptField else {
            return
        }

        let config = VisionConfig(
            provider: providerPopup.titleOfSelectedItem ?? "gemini",
            baseUrl: baseUrlField.stringValue.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
            apiKey: keyField.stringValue.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
            model: modelField.stringValue.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
            prompt: promptField.stringValue.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        )
        saveVisionConfig(config)
        restartService()
        settingsWindow?.close()
        settingsWindow = nil
    }

    @objc private func quit() {
        stopForegroundService()
        NSApp.terminate(nil)
    }

    private func startForegroundService() {
        if let process = proxyProcess, process.isRunning {
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [ctlPath, "foreground"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            proxyProcess = process
        } catch {
            proxyProcess = nil
        }
    }

    private func stopForegroundService() {
        if let process = proxyProcess, process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        proxyProcess = nil
        runCtl("stop")
    }

    private func refreshStatus() {
        if isServiceRunning() {
            if isVisionModelConfigured() {
                setServiceStatus(running: true, text: "状态：识图服务已开启")
            } else {
                setServiceStatus(running: false, text: "状态：请先配置识图模型")
            }
        } else {
            setServiceStatus(running: false, text: "状态：识图服务已停止")
        }
    }

    private func setServiceStatus(running: Bool, text: String) {
        statusItem.button?.image = makeStatusImage(active: running)
        statusItem.button?.title = ""
        statusItem.button?.toolTip = running ? "Claude Code 识图服务：已开启" : "Claude Code 识图服务：已停止"
        statusMenuItem?.title = text
    }

    private func isServiceRunning() -> Bool {
        runCtl("status").trimmingCharacters(in: .whitespacesAndNewlines) == "running"
    }

    private func makeStatusImage(active: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()

        NSColor.clear.setFill()
        NSRect(origin: .zero, size: size).fill()

        if let menuIcon {
            menuIcon.draw(in: NSRect(x: 0, y: 0, width: 18, height: 18))
        } else {
            let stroke = NSColor.labelColor
            stroke.setStroke()
            let eyeRect = NSRect(x: 2.5, y: 5.0, width: 13.0, height: 8.0)
            let eye = NSBezierPath(ovalIn: eyeRect)
            eye.lineWidth = 1.6
            eye.stroke()

            let dot = NSBezierPath(ovalIn: NSRect(x: 7.2, y: 7.2, width: 3.6, height: 3.6))
            stroke.setFill()
            dot.fill()
        }

        if active {
            NSColor.systemGreen.setFill()
            NSBezierPath(ovalIn: NSRect(x: 12.0, y: 12.0, width: 4.5, height: 4.5)).fill()
        } else {
            NSColor.systemRed.setStroke()
            let slash = NSBezierPath()
            slash.move(to: NSPoint(x: 4.0, y: 3.5))
            slash.line(to: NSPoint(x: 14.5, y: 14.5))
            slash.lineWidth = 1.8
            slash.stroke()
        }

        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    private func addLabel(_ text: String, x: CGFloat, y: CGFloat, to view: NSView) {
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: x, y: y, width: 100, height: 20)
        view.addSubview(label)
    }

    private func loadVisionConfig() -> VisionConfig {
        let url = URL(fileURLWithPath: visionConfigPath)
        if let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(VisionConfig.self, from: data) {
            return config
        }
        return VisionConfig(
            provider: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "",
            model: "gemini-2.5-flash",
            prompt: "请用中文详细描述这张图片，重点关注可见文字、界面元素、物体、布局，以及和用户问题相关的信息。"
        )
    }

    private func isPlaceholderVisionValue(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).lowercased()
        return normalized.isEmpty
            || normalized == "your_vision_api_key"
            || normalized == "your_gemini_api_key"
            || normalized == "vision-model-name"
            || normalized.contains("api.example.com")
    }

    private func isVisionModelConfigured() -> Bool {
        let config = loadVisionConfig()
        if isPlaceholderVisionValue(config.apiKey) || isPlaceholderVisionValue(config.model) {
            return false
        }
        if config.provider == "openai-compatible" && isPlaceholderVisionValue(config.baseUrl) {
            return false
        }
        return true
    }

    private func saveVisionConfig(_ config: VisionConfig) {
        let url = URL(fileURLWithPath: visionConfigPath)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if let data = try? JSONEncoder.pretty.encode(config) {
            try? data.write(to: url)
        }
    }

    @discardableResult
    private func runCtl(_ command: String) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [ctlPath, command]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return "error: \(error.localizedDescription)"
        }
    }
}

let app = NSApplication.shared
let delegate = VisionApp()
app.delegate = delegate
app.run()

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
