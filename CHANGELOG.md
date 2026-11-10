# Changelog

## 0.1.0 — 2026-11-10

First public release.

### Added
- **Engine built on Pi** (`@earendil-works/pi-coding-agent` 1.5.1, MIT): agent loop, read/ls/find/grep/edit/write/bash tools, persistent sessions per project folder, automatic context compaction, retries.
- **Native workspace**: streamed replies, a card for every tool call, inline diffs for edits and new files, the exact command for shell calls, **Allow / Decline** on every edit, write and command, plus "allow for this session" per tool. Stop, New chat, tier switcher (Fast / Balanced / Smart).
- **Publik by default**: per-install key provisioning (`POST /installs`) after a one-paragraph disclosure, `publik-balanced` default tier, live balance from `x-publik-*` headers, HTTP 402 shows Publik's message and its one top-up link.
- **Bring your own key**: any OpenAI-compatible endpoint or local model server; key saved with OS encryption or kept for the session.
- **`PUBLIK_SELF_TEST=1`** on the built app prints `publik self-test: ok publik-code 0.1.0 …` and exits.
- Local loopback gateway with a per-launch token, so the engine never sees a real API key; 4 MB request cap.
- Tests: Publik module, gateway, Pi engine against a scripted model, Electron end-to-end (approve an edit, decline a command).

### Changed
- Replaced the embedded OpenCode engine and web UI used in October 2026 development builds.

### Known limitations
- Builds are unsigned (macOS Gatekeeper / Windows SmartScreen warnings).
- Windows build is cross-compiled on macOS; interactive Windows testing pending.
- No MCP servers, plugins or code editor yet. Tool approvals are not an OS sandbox.
