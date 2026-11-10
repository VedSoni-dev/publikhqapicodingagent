# Developer guide

A desktop coding agent for **macOS and Windows**, using your Publik balance or your own OpenAI-compatible API. Open a local project, describe a task, and approve the agent's edits and commands.

Publik Code's engine is **built on [Pi](https://github.com/earendil-works/pi)** (`@earendil-works/pi-coding-agent`, MIT): Pi supplies the agent loop, the read/edit/write/bash tools, sessions and context compaction. Publik Code adds the desktop UI, Publik as the default provider, an approval gate, and a local gateway that keeps keys away from the engine. It is an independent project, not Pi itself and not affiliated with the Pi project.

## Status

v0.1.0. Publik provisioning is wired and self-tested from the packaged macOS app (`publik self-test: ok publik-code 0.1.0`). Builds are unsigned; Apple notarization and Windows code signing are not configured. The Windows installer is cross-built on macOS; interactive Windows behavior still needs a Windows laptop. GitHub-hosted CI is configured but currently blocked by a GitHub account billing lock.

## Run from source

Install Node.js 22.19 or newer and Git, then:

```sh
git clone https://github.com/VedSoni-dev/publikhqapicodingagent.git
cd publikhqapicodingagent
npm ci
npm start
```

Source checkouts don't include the Publik app token (`publik-app-token.txt` is kept out of git), so from source use **Your own API key**, or set `PUBLIK_API_KEY`. Release builds include the token and connect to Publik with no key.

1. Connect Publik after reading the first-run disclosure, or choose **Your own API key**.
2. For Publik, open **Link this computer & pick a plan** in your browser ($0.05 free on first link). Return and refresh the balance.
3. Choose a project folder you trust.
4. Ask for a change. Reads, listings and searches run freely; every edit, file write and shell command shows a diff or the command and waits for **Allow** / **Decline**. "Allow for this session" skips the prompt for that tool until you close the project.
5. Switch Fast / Balanced / Smart from the workspace bar. **New chat** starts a fresh session; reopening a project continues its last session.

## Publik integration

- Base URL `https://publikhq.com/api/v1`; tiers `publik-fast`, `publik-balanced` (default), `publik-smart` (needs a linked computer).
- `src/publik.ts` is Publik's TypeScript reference module: disclosure, `POST /installs` provisioning, the per-app credential file (mode 0600), `selfTest()`.
- Resolution order: your own key > `PUBLIK_API_KEY` / `PUBLIK_API_BASE_URL` > credential file > provision on first launch after consent.
- On HTTP 402 the workspace shows Publik's message and its single top-up/claim link; your own key keeps working.
- `x-publik-*` headers update the balance shown in the workspace bar.
- Self-test: `PUBLIK_SELF_TEST=1 "Publik Code.app/Contents/MacOS/Publik Code"` prints `publik self-test: ok publik-code <version> …` and exits.

## How it works

```text
Electron window (sandboxed renderer: onboarding, workspace, approvals)
  └─ main process
       ├─ Publik provisioning + wallet (src/publik.ts)
       ├─ Pi agent session (src/engine.ts, @earendil-works/pi-coding-agent)
       │    ├─ read / ls / find / grep        → run freely
       │    └─ edit / write / bash            → approval gate (Pi tool_call hook)
       └─ loopback gateway (src/gateway.ts, random bearer token)
            └─ Publik API or your own provider (real key only here)
```

Pi sees only the loopback URL and a per-launch token. Pi's state (sessions) lives in the app's own data folder, not `~/.pi`. Project `.pi/` extensions, skills and prompt templates are not loaded; `AGENTS.md` / `CLAUDE.md` context files are, as in Pi.

**Approvals are not a sandbox.** An approved command runs with your user account's permissions, and file contents or tool output can steer the model (prompt injection). Open projects you trust; for untrusted code use a VM or container.

## Development and verification

```sh
npm run typecheck
npm test             # unit + Pi engine tests against a scripted local model
npm run test:desktop # Electron end-to-end: connect, approve an edit, decline a command
```

None of these spend Publik credit.

```sh
npm run package:mac   # DMG and ZIP
npm run package:win   # NSIS installer
```

## License and credits

MIT. Built on Pi (MIT, © Mario Zechner); see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The Publik integration reference is attributed in its source.
