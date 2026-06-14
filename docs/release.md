# 发布流程

当前建议版本号：`0.1.0`。

原因：

- 项目已经可用，适合公开预览。
- 但还没有开发者证书签名、公证、自动更新等成熟 macOS 分发能力。
- `1.0.0` 建议留给安装、签名、公证和兼容性都稳定之后。

## 本地打包

```bash
npm install
npm run check
npm run check:macos
npm run package:dmg
```

生成文件：

```text
dist/ClaudeCode-Vision-0.1.0.dmg
```

## 创建 GitHub Release

```bash
git tag v0.1.0
git push origin v0.1.0

gh release create v0.1.0 \
  dist/ClaudeCode-Vision-0.1.0.dmg \
  --title "ClaudeCode-Vision v0.1.0" \
  --notes "首个公开预览版：为 Claude Code 添加图片理解能力的 macOS 菜单栏应用，兼容 cc-switch。"
```

## macOS 安全提示

当前 DMG 使用 ad-hoc 签名，没有 Apple Developer ID 公证。用户首次打开时可能需要在系统设置的安全性页面允许打开。

后续正式版建议：

- 使用 Developer ID Application 证书签名。
- 对 DMG 进行 notarization。
- 在 Release notes 中说明 macOS 首次打开步骤。
