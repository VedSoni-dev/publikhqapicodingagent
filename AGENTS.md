# Publik Code

Keep the agent loop in Pi (`@earendil-works/pi-coding-agent`, pinned). Publik Code owns only the desktop UI, Publik provider wiring, approvals and the local gateway. Do not fork Pi's tools or loop; extend through its SDK/extension API. Present it as "built on Pi", never as Pi.

- Main process: `src/main.ts`; launcher UI: `src/renderer/`; agent engine (Pi SDK): `src/engine.ts`; streaming model adapter: `src/gateway.ts`.
- Keep upstream credentials out of renderers, Pi config, command arguments, and logs (Pi only ever sees the local gateway token). Do not read `.env*` files.
- Test with local fake providers first. Live model calls spend real user credit.
- Verify changes with `npm run typecheck`, `npm test`, and relevant smoke tests. Build one platform at a time; do not overwrite a running executable.
- Use the canonical real path for workspaces, especially on macOS where `/var` and `/private/var` differ.
- Keep attribution (`THIRD_PARTY_NOTICES.md`, `resources/PI-LICENSE`). Do not claim Windows interactive testing based solely on a cross-platform build.
- `publik-app-token.txt` is gitignored here (owner's rule); CI writes it from the `PUBLIK_APP_TOKEN` secret.

## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: publik-app-token.txt (public by design; kept out of git in this repo, injected at build) or PUBLIK_APP_TOKEN
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
