# Changelog

## Unreleased

- Nothing yet.

## 0.1.2

- Add a `visionctl.sh doctor` diagnostic command with redacted runtime, routing, upstream, and vision model status.
- Add a menu bar action to copy diagnostics for issue reports and troubleshooting.
- Bump the macOS app bundle version for the next DMG build.

## 0.1.1

- Fix first-launch vision model placeholder config.
- Show a clear menu bar status when the vision model is not configured.
- Return a clear error when image requests arrive before configuring a vision API key.

## 0.1.0

- Initial macOS menu bar app.
- Local Anthropic-compatible vision proxy for Claude Code.
- `cc-switch` provider tracking.
- Gemini and OpenAI-compatible vision provider support.
- Image-description cache.
