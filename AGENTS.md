# Publik Code

Keep the application a thin desktop integration around pinned OpenCode. Do not implement a second agent loop, editor, terminal, or diff viewer when upstream already supplies it.

- Main process: `src/main.ts`; launcher UI: `src/renderer/`; agent lifecycle: `src/runtime.ts`; streaming model adapter: `src/gateway.ts`.
- Keep upstream credentials out of renderers, OpenCode config, command arguments, and logs. Do not read `.env*` files.
- Test with local fake providers first. Live model calls spend real user credit.
- Verify changes with `npm run typecheck`, `npm test`, and relevant smoke tests. Build one platform at a time; do not overwrite a running executable.
- Use the canonical real path for workspaces, especially on macOS where `/var` and `/private/var` differ.
- Bundle platform binaries from the exact lockfile version. Keep attribution. Do not claim Windows interactive testing based solely on a cross-platform build.

## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: publik-app-token.txt (public by design, committed) or PUBLIK_APP_TOKEN
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
