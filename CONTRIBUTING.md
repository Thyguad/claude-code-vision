# Contributing

Thanks for helping improve ClaudeCode-Vision.

## Development Setup

Requirements:

- macOS 13 or later for the menu bar app.
- Node.js 20 or newer.
- Xcode Command Line Tools.
- `cc-switch` configured for Claude Code if you want to test routing end to end.

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
npm run check:macos
```

Reinstall the local app after changes:

```bash
bash scripts/install.sh
```

Run the proxy in the foreground:

```bash
~/.claude/vision-proxy/visionctl.sh foreground
```

## Pull Requests

- Keep changes focused and explain the user-facing behavior.
- Do not commit API keys, local runtime state, logs, caches, or built app bundles.
- Include manual test notes for routing, provider switching, or macOS UI changes.
- Prefer small compatibility-preserving changes because this app edits Claude Code and `cc-switch` settings while running.
