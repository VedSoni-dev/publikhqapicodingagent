# Validation — 0.1.0

Verified on Apple Silicon macOS, November 10, 2026.

## Passed
- `npm run typecheck`; `npm test` — 19 tests: Publik module (provider order, `POST /installs` provisioning, credential file mode 0600, 402 parsing, self-test line), gateway (auth, streaming, 402, 4 MB cap, tier validation), and the Pi engine against a scripted OpenAI-compatible model (reads run freely, writes ask, a decline is honored and nothing is written, `x-publik-*` meter headers flow, the real key never reaches the engine).
- `npm run test:desktop` from source **and** against the packaged `Publik Code.app`: onboarding, own-key connect, key redaction from renderer state, Pi workspace, an approved edit applied on disk, a declined shell command blocked, close project, provider switch.
- Packaged app Publik check with the real app token: `publik self-test: ok publik-code 0.1.0 (install f8d28e78)`.
- Live Publik API from the provisioned install: `GET /wallet` 200; `POST /chat/completions` (publik-balanced) → `402 insufficient_credit` with `top_up_url` (correct for an unlinked $0.00 install; surfaced in-app as message + one link).
- macOS arm64 DMG and ZIP build.

## Not yet verified
- A live model completing a full agent task: needs the computer linked to a Publik account (or a top-up). Tracked in the maintainer log.
- Interactive Windows behavior (installer is cross-built), macOS Intel.
- Signed/notarized distribution: no signing identities configured.
- GitHub Actions: workflow builds, tests and packages on push, but GitHub refuses to start jobs ("account is locked due to a billing issue").
