# ClaudeCode-Vision

> 一个 macOS 菜单栏应用：当 `cc-switch` 当前选中的 Claude Code provider 不支持图片时，为 Claude Code 补上图片理解能力。

ClaudeCode-Vision 会在本机启动一个 Anthropic 兼容代理。Claude Code 请求里如果包含图片块，代理会先调用你配置的视觉模型生成图片描述，再把图片块替换成文本描述，最后把请求转发给 `cc-switch` 当前选中的 Claude provider。

停止应用后，Claude Code 会恢复到正常的 `cc-switch` 配置。

## 功能

- macOS 菜单栏应用，可启动、停止、重启、查看服务状态和复制诊断信息。
- 与 `cc-switch` 配合使用，自动跟随 Claude provider 切换。
- 以 `cc-switch` 当前 Claude provider 作为真实上游。
- 如果 provider 配置被本地代理地址污染，会尝试自动恢复。
- 支持 Gemini 和 OpenAI-compatible 视觉 API。
- 缓存图片描述，避免同一张图片重复调用视觉模型。
- 中文图形界面，可配置视觉模型地址、API Key、模型名和提示词。

## 工作原理

Claude Code 通常从 `~/.claude/settings.json` 读取 `ANTHROPIC_BASE_URL`。

ClaudeCode-Vision 启动时会：

1. 从 `cc-switch` 捕获当前 Claude provider 作为上游。
2. 把 Claude Code 的 `ANTHROPIC_BASE_URL` 改为 `http://127.0.0.1:18090`。
3. 在本机启动代理服务。
4. 代理持续监听 `cc-switch` provider 变化，并自动更新上游。

ClaudeCode-Vision 停止时会把 Claude Code 恢复到当前 `cc-switch` provider。

运行时文件位置：

```text
~/.claude/vision-proxy/proxy.mjs
~/.claude/vision-proxy/visionctl.sh
~/.claude/vision-proxy/vision-model.json
~/.claude/vision-proxy/upstream.json
~/.claude/vision-proxy/image-cache.json
~/.claude/vision-proxy.log
```

## 环境要求

- macOS 13 或更新版本。
- Node.js 20 或更新版本。
- Xcode Command Line Tools，包含 Swift 编译器。
- 已为 Claude Code 配置好 `cc-switch`。

如未安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

## 安装

### 方式一：下载 DMG

从 GitHub Releases 下载 `ClaudeCode-Vision-0.1.2.dmg`，打开后把 `ClaudeCode-Vision.app` 拖到 `Applications`。

首次启动时，应用会把内置代理运行时安装到：

```text
~/.claude/vision-proxy
```

随后会自动启动本地识图代理。

### 方式二：从源码安装

克隆仓库：

```bash
git clone https://github.com/Thyguad/claude-code-vision.git
cd claude-code-vision
bash scripts/install.sh
```

安装脚本会写入：

- 应用：`/Applications/ClaudeCode-Vision.app`
- 代理运行时：`~/.claude/vision-proxy`

安装后从 `/Applications` 打开 `ClaudeCode-Vision.app`。它会出现在 macOS 菜单栏。

## 配置视觉模型

打开 `ClaudeCode-Vision.app`，点击菜单栏图标，选择 `识图模型设置...`。

支持的 provider：

- `gemini`
- `openai-compatible`

Gemini 示例：

```json
{
  "provider": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "apiKey": "YOUR_GEMINI_API_KEY",
  "model": "gemini-2.5-flash",
  "prompt": "请用中文详细描述这张图片，重点关注可见文字、界面元素、物体、布局，以及和用户问题相关的信息。"
}
```

OpenAI-compatible 示例：

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "YOUR_VISION_API_KEY",
  "model": "vision-model-name",
  "prompt": "请用中文详细描述这张图片，重点关注可见文字、界面元素、物体、布局，以及和用户问题相关的信息。"
}
```

不要提交真实 API Key。运行时配置保存在：

```text
~/.claude/vision-proxy/vision-model.json
```

## 使用方式

1. 使用 `cc-switch` 选择你平时使用的 Claude provider。
2. 启动 `ClaudeCode-Vision.app`。
3. 确认菜单栏状态为 `状态：识图服务已开启`。
4. 新开一个 Claude Code 会话。
5. 像平常一样发送带图片的提示。

服务运行期间，Claude Code 会经过本地代理：

```text
http://127.0.0.1:18090
```

停止服务或退出应用后，脚本会把 Claude Code 恢复到当前 `cc-switch` provider。

## 开发

安装依赖：

```bash
npm install
```

运行检查：

```bash
npm run check
npm run check:macos
```

构建应用包：

```bash
npm run build:app
```

生成 DMG：

```bash
npm run package:dmg
```

产物位置：

```text
dist/ClaudeCode-Vision-0.1.2.dmg
```

修改后重新安装本地应用：

```bash
bash scripts/install.sh
```

前台运行代理，便于调试：

```bash
~/.claude/vision-proxy/visionctl.sh foreground
```

查看日志：

```text
~/.claude/vision-proxy.log
```

## 故障排查

查看服务状态：

```bash
~/.claude/vision-proxy/visionctl.sh status
```

复制或查看脱敏诊断信息：

```bash
~/.claude/vision-proxy/visionctl.sh doctor
```

也可以在菜单栏里选择 `复制诊断信息`，再把剪贴板内容贴到 issue 或聊天里排查问题。

查看当前捕获到的上游 provider：

```bash
~/.claude/vision-proxy/visionctl.sh upstream
```

如果 `18090` 端口被占用，可以换端口运行：

```bash
PROXY_PORT=18091 ~/.claude/vision-proxy/visionctl.sh foreground
```

如果停止应用后 Claude Code 仍然指向本地代理，执行：

```bash
~/.claude/vision-proxy/visionctl.sh stop
```

## 安全与隐私

- 图片内容会发送给你配置的视觉模型 provider。
- Claude provider token 会在运行时从本地 Claude Code 或 `cc-switch` 配置中读取。
- 分享日志或运行时 JSON 前，请先移除 API Key、token、图片内容和 provider 私密信息。
- 应用运行期间会修改 `~/.claude/settings.json`，停止时会恢复。

更多说明见 [SECURITY.md](SECURITY.md)。

## 说明

- 如果当前 Claude 模型本身已经支持多模态，通常不需要运行本应用。
- 如果当前 provider 是纯文本模型，请在需要图片理解的 Claude Code 会话前启动本应用。
- 服务运行时，新开的 Claude Code 会话会通过本地代理。
- 服务停止时，Claude Code 会按 `cc-switch` 原本方式工作。
- 本项目与 Anthropic、Claude Code、Gemini、OpenAI、`cc-switch` 均无官方关联。

## 许可证

MIT。见 [LICENSE](LICENSE)。
