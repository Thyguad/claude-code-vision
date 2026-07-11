# Windows 开发与验证

当前 Windows 目标是 Windows 10/11 x64。便携包包含 self-contained .NET 8 托盘程序和固定 Node.js 20 runtime，不要求用户另外安装运行时。

## CI 产物

`windows-check` 会完成以下工作：

1. 运行跨平台 Node 测试。
2. 发布 `ClaudeCode-Vision.exe`。
3. 把固定 Node.js、代理、生产依赖和 Service CLI 组装到 `runtime/`。
4. 上传 `ClaudeCode-Vision-windows-x64` artifact。

目录结构：

```text
ClaudeCode-Vision-windows-x64/
  ClaudeCode-Vision.exe
  *.dll
  runtime/
    proxy.mjs
    core/
    service/
    node/node.exe
    node_modules/
```

CI 同时生成便携 ZIP 和 per-user 安装器。安装器默认写入 `%LOCALAPPDATA%\Programs\ClaudeCode-Vision`，不要求管理员权限；卸载前会调用 Service CLI 停止代理并恢复 Claude Code 配置。运行 `ClaudeCode-Vision.exe` 后会显示系统托盘图标。

## 本地构建

在 Windows PowerShell 中：

```powershell
npm ci
npm run check:node
dotnet publish windows/ClaudeCodeVision.Windows/ClaudeCodeVision.Windows.csproj `
  -c Release -r win-x64 --self-contained true -o build/windows-tray
$env:EMBEDDED_NODE_PATH = (Get-Command node).Source
$env:EMBEDDED_NODE_LICENSE = Join-Path (Split-Path $env:EMBEDDED_NODE_PATH) "LICENSE"
npm run package:windows-runtime
npm run package:windows-portable
```

最终目录为 `dist/ClaudeCode-Vision-windows-x64`。

安装器使用 Inno Setup 6：

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" `
  "/DAppVersion=0.1.2" windows/installer/ClaudeCodeVision.iss
```

## 实机验证清单

- 用户目录含空格、中文或其他非 ASCII 字符。
- 启动、停止、重启、重复启动和重复停止。
- 退出托盘应用后 `~/.claude/settings.json` 不再指向 `127.0.0.1:18090`。
- 设置窗口可保存 Gemini 和 OpenAI-compatible 配置，且 API key 不出现在诊断信息中。
- 日志打开与诊断复制正常。
- 端口冲突会显示明确错误，不会改写 Claude 配置。
- Windows Defender/SmartScreen 对未签名便携程序的行为有记录。

## cc-switch 数据采集

Windows provider-store 尚未直接读取 cc-switch SQLite。请在 Windows 实机确认以下信息后再实现：

- cc-switch 配置目录与数据库绝对路径。
- `settings.json` 中当前 Claude provider 字段。
- `providers` 与 `provider_endpoints` 的脱敏 schema。
- 切换 provider 时 Claude `settings.json` 是否同步更新。

只提交脱敏 fixture 到 `test/fixtures/windows/`，不要提交 token、API key、个人 URL 或图片内容。
