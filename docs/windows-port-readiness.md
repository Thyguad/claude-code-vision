# Windows 适配准备

## 目标范围

第一版 Windows 适配建议以 Windows 10/11 x64、Node.js 20+ 和已安装 cc-switch 为基线，交付一个托盘应用，功能与当前 macOS 菜单栏版本对齐：

- 启动、停止、重启和查看代理状态。
- 配置 Gemini 或 OpenAI-compatible 视觉模型。
- 自动跟随 cc-switch 当前 Claude provider。
- 启动时把 Claude Code 路由到本地代理，停止或退出时恢复上游配置。
- 查看日志、复制脱敏诊断信息。
- 提供可安装、可卸载的 Windows 安装包。

首版暂不包含自动更新、代码签名和 ARM64 安装包；这些作为分发阶段的后续工作。

## 当前代码的可复用程度

| 模块 | 现状 | Windows 策略 |
| --- | --- | --- |
| `src/proxy.mjs` 的 HTTP、识图、缓存和上游转发 | 基本跨平台 | 直接复用，并补测试 |
| Claude/cc-switch 配置文件路径 | 使用 `os.homedir()` 和 `path.join()` | 可复用，但应集中到平台路径模块 |
| cc-switch SQLite 读取 | Node 内嵌 Python，硬编码 `/usr/bin/python3` | 必须移出代理核心；改为可替换的 provider store |
| 服务生命周期 | 675 行 Bash，依赖 PID、signal、`lsof`、`setsid`、`nohup`、`curl` | 用 Node 控制器重写，macOS shell 只保留兼容入口 |
| 桌面 UI | 514 行 AppKit/Swift | Windows 新建托盘壳；业务逻辑不要复制进 UI |
| 构建与安装 | Bash、Swift、`.app`、DMG、`codesign` | 新增 Windows 构建和安装流程 |
| CI | Ubuntu 语法检查 + macOS Swift 编译 | 增加 `windows-latest`，运行核心测试和 Windows 构建 smoke test |

## 已确认的主要阻塞项

1. `src/proxy.mjs` 在读取 cc-switch 数据库时调用固定路径 `/usr/bin/python3`。Windows 通常只有 `python.exe` 或 `py.exe`，且不能假定用户安装 Python。
2. `scripts/visionctl.sh` 承担了配置捕获、SQLite 查询、进程管理、健康检查、恢复配置和诊断生成，多项命令只适用于 Unix。
3. Swift 应用直接执行 `/bin/bash` 和 `visionctl.sh`，并使用 AppKit、POSIX 文件锁和 macOS 工作区 API。
4. 安装包只包含 macOS 目录结构，运行时依赖通过首次启动执行 `npm install` 获取；Windows 安装应避免首次启动再联网装依赖。
5. 代理核心、配置切换和进程控制没有测试。Windows 适配会触碰“退出时恢复 Claude 配置”这一高风险路径，不能只靠手工验证。

## 推荐目标结构

```text
src/
  proxy.mjs                 # 仅负责 HTTP/识图/转发
  core/
    paths.mjs               # 用户目录和运行时文件位置
    json-store.mjs          # 原子 JSON 读写
    routing.mjs             # 捕获、切换、恢复 Claude 配置
    cc-switch-store.mjs     # 当前 provider 查询接口
  service/
    cli.mjs                 # start/stop/restart/status/doctor/foreground
    process-manager.mjs     # 跨平台进程和端口检查
macos/                      # 现有 Swift 托盘壳
windows/                    # Windows 托盘壳与打包配置
test/                       # core/service 的 Node 测试
```

关键原则是让两个桌面壳只调用同一套 `service/cli.mjs`，不在 Swift 或 Windows UI 中各自实现配置切换逻辑。

## 技术决策建议

### Windows 托盘壳

优先采用 C#/.NET 8 的 WinForms 托盘应用。它对托盘菜单、单实例、设置窗口、剪贴板、打开日志和子进程控制都有系统原生支持，安装体积也比引入 Electron 更容易控制。UI 通过命令行调用共享 Node service controller。

如果团队更重视单一 JavaScript 技术栈，可改用 Electron，但需要接受更大的安装包和额外的应用生命周期复杂度。

### SQLite

先确认 cc-switch 在 Windows 上的实际数据目录和数据库 schema 与 macOS 是否一致。实现 `cc-switch-store` 接口后，建议选用随安装包分发的 SQLite 访问方式，不依赖系统 Python。可选方案按优先级评估：

1. cc-switch 若提供稳定 CLI/API，直接调用它。
2. 使用带 Windows 预编译产物的 Node SQLite 包，并在 CI 验证安装。
3. 由 .NET 托盘壳查询 SQLite，再把 provider 信息传给 Node controller。

不要在确认 cc-switch Windows 数据格式前锁死某个 SQLite 依赖。

### 运行时分发

Windows 安装包应内置已经安装好的生产依赖，避免首次启动执行 `npm install`。Node 可先要求用户安装 Node.js 20+，待功能稳定后再决定是否捆绑 Node runtime。首版建议选择“外部 Node + 启动前明确诊断”，降低打包变量。

## 实施顺序

### 阶段 1：抽离跨平台核心

- 将路径、JSON 原子写入、cc-switch 查询、路由切换和诊断从 `proxy.mjs`/Bash 中拆出。
- 新建 Node service CLI，覆盖 `foreground/status/doctor`，再覆盖 `start/stop/restart`。
- 保留 `visionctl.sh` 作为薄兼容层，避免破坏现有 macOS 用户。
- 对临时目录运行测试，不读写开发机真实的 `~/.claude`。

验收：macOS 功能不回归；核心测试在 Ubuntu、macOS、Windows 上均通过。

### 阶段 2：Windows 最小可用版

- 确认 Windows 上 Claude Code 和 cc-switch 的实际路径、provider schema 与切换行为。
- 创建托盘壳和设置窗口，接入共享 service CLI。
- 实现单实例、异常退出恢复、日志打开和诊断复制。
- 验证休眠/唤醒、系统代理、有空格的用户目录、非管理员安装和端口冲突。

验收：从安装到带图请求成功，全程不需要 Bash、Python、WSL 或管理员权限。

### 阶段 3：安装与发布

- 生成 x64 安装包，安装到用户目录并添加卸载项。
- 安装、升级和卸载前安全停止服务并恢复 Claude 配置。
- 增加 Windows CI 构建产物和 smoke test。
- 后续补代码签名、ARM64 和自动更新。

## 必需测试清单

- 配置文件不存在、为空、损坏和只读时的行为。
- 启动前捕获上游，停止、正常退出和强制终止后的恢复。
- cc-switch 切换 provider 后，上游更新且本地路由保持不变。
- 端口已占用、PID 文件过期、重复启动和重复停止。
- 用户目录含空格、中文和非 ASCII 字符。
- Gemini 与 OpenAI-compatible 两条识图链路，包括 base64 和 URL 图片。
- HTTP 流式响应、错误透传、超时、系统代理和大图片限制。
- 诊断信息不泄露 API key、Anthropic token 或图片内容。
- 安装、覆盖升级和卸载不会把 `settings.json` 留在本地代理地址。

## 开工前需要在 Windows 实机采集的信息

以下信息不应凭 macOS 行为推断：

- `%USERPROFILE%` 下 Claude Code 与 cc-switch 的实际配置路径。
- cc-switch 当前版本的 `settings.json` 和 SQLite schema（只需结构，不要提交 token）。
- cc-switch 切换 provider 时会修改哪些文件、字段和时间戳。
- `claude` 进程读取环境/配置的时机，以及已有会话是否需要重启。
- Windows Defender/SmartScreen 对未签名托盘程序和本地监听端口的提示。

建议把采集结果保存成脱敏 fixtures，作为 `test/fixtures/windows/` 的输入，而不是把个人配置直接提交到仓库。

## 第一批任务拆分

1. **Core extraction**：拆出 paths、JSON store、routing 和 provider store 接口，补 Node 测试。
2. **Service CLI**：用 Node 替代 Bash 主逻辑，macOS shell 改为薄包装。
3. **Windows discovery**：在 Windows 实机采集 cc-switch 路径/schema，形成脱敏 fixtures。
4. **Windows tray spike**：实现 C# 托盘、单实例和 `status/foreground/stop` 调用。
5. **Windows CI/package**：添加 runner、构建 smoke test 和首个安装包。

任务 1 和任务 3 可以并行；任务 2 依赖任务 1，托盘正式接入依赖任务 2 和任务 3。
