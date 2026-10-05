# Validation — 0.1.0 developer preview

Verified locally on Apple Silicon macOS, October 5, 2026:

- TypeScript type check passes.
- All 15 automated tests pass (including auth, streaming, payment errors, body limits, tier validation, and environment isolation).
- The pinned OpenCode 1.18.34 engine completes a mocked streaming conversation with an actual local file-read tool and a tool-result round trip.
- Electron onboarding, provider switching, session-only credentials, renderer credential redaction, embedded engine view, and shutdown pass automated UI tests.
- The packaged macOS app passes the same desktop smoke test.
- macOS ARM64 DMG/ZIP and Windows x64 NSIS installer builds complete. The Windows package contains a PE32+ x86-64 OpenCode executable.
- Dependency audit reports zero known vulnerabilities at verification time.
- Desktop and narrow-window visual reviews completed; narrow text spacing was corrected.

Not yet verified:

- Live Publik provisioning, account linking, wallet response shape, and real model/tool calls: requires the approved listing, builder authorization, public app token, and a linked balance.
- Interactive Windows behavior and macOS Intel builds.
- Signed/notarized distribution: no signing identities were configured.

GitHub Actions run 37275427723 did not execute build steps. GitHub reported: “The job was not started because your account is locked due to a billing issue.” No CI pass is claimed. The Windows installer was cross-built locally instead.

The approved `publik.manifest.json` was submitted after device authorization. Publik returned status `live` at https://publikhq.com/publik-code, attributed to `VedSoni-dev`, with version ID `fa22ba86-28b6-4308-a6bb-0ddda42b261a`. The page identifies it as live but not yet reviewed by Publik. It is a source-install listing; no GitHub release has been published.

App-token issuance returned `claim_first`: the repository owner must use “Your app? Claim it with GitHub” on the listing. After the claim, retry the documented app-token endpoint, run the live API proof, rebuild the installers with the public token, and publish a GitHub release. No app token or live inference result is claimed yet.
