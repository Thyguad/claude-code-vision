# Security Policy

## Reporting a Vulnerability

Please report security issues privately to the repository maintainer instead of opening a public issue.

Include:

- Affected version or commit.
- Steps to reproduce.
- Impact and any known workaround.

## Sensitive Data

ClaudeCode-Vision reads local Claude Code and `cc-switch` configuration and may handle API tokens at runtime. Do not include real tokens, provider configs, request payloads, logs, or image-cache contents in public issues.

Runtime files that must stay local include:

- `~/.claude/settings.json`
- `~/.claude/vision-proxy/vision-model.json`
- `~/.claude/vision-proxy/upstream.json`
- `~/.claude/vision-proxy/image-cache.json`
- `~/.claude/vision-proxy.log`
