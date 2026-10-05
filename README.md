# Publik Code

A desktop coding agent for **macOS and Windows**, using your Publik balance or your own OpenAI-compatible API. Open a local project, describe a task, and review the agent's edits and commands.

Publik Code reuses the **OpenCode 1.18.34 engine and its web interface** inside an Electron launcher. It is an independent project, not an official OpenCode product. We maintain the small desktop and Publik integration layer instead of forking the agent loop or editor.

## Status

Initial developer preview. The launcher, local engine, credential handling, and mock-provider coding flow are implemented. The Publik listing, app token, browser linking, and real paid API proof must be completed before the no-key installation path is available in distributed builds. Until then, use your own API key or the `PUBLIK_API_KEY` environment override.

Builds are unsigned; Apple notarization and Windows code signing are not configured. GitHub-hosted build jobs are currently blocked by an account billing lock. A Windows x64 installer can be cross-built on macOS; interactive behavior still needs validation on a Windows laptop. Git is recommended on both platforms. Install Git for Windows if you want the agent to run Bash commands.

## Run from source

Install Node.js 22.18 or newer and Git, then:

```sh
git clone https://github.com/VedSoni-dev/publikhqapicodingagent.git
cd publikhqapicodingagent
npm ci
npm start
```

The pinned OpenCode binary is downloaded by npm for your OS and bundled with the application. No separate OpenCode installation is required. First use may download upstream runtime dependencies. Source builds support macOS and Windows; Linux packaging is not configured.

1. Connect Publik after reading the first-run disclosure, or choose **Your own API key**.
2. For Publik, open **Link this computer & pick a plan** in your browser. Return and refresh the balance.
3. Select Fast, Balanced, or Smart, then choose a project folder you trust.
4. Use OpenCode's interface to give the agent a task. Reads are allowed; edits, shell commands, and other tools ask for approval.
5. Use **Account & usage** to return to the launcher while the workspace stays open.

Your own API connection takes precedence when saved. Stop the workspace before switching providers. Choose **Use Publik instead** to remove the saved own-key connection.

## Publik integration

- Base URL: `https://publikhq.com/api/v1`.
- Tiers: `publik-fast`, `publik-balanced`, `publik-smart`. Balanced is the initial coding selection; Fast is the cheapest option. Smart needs a linked computer.
- New installs start at $0.00; first account linking grants $0.05 once, according to Publik's documentation.
- Uses Publik's TypeScript reference module for consent, installation provisioning, and the documented credential path.
- The public builder token belongs in `publik-app-token.txt` at the repository root and is packaged with the app. It only provisions keys for this app. It is intentionally committed once obtained. No fake token is included.
- Each installation's private key stays in its per-app Publik credential file, never in the repository, renderer state, command arguments, or application logs.
- `PUBLIK_API_KEY` and `PUBLIK_API_BASE_URL` override the saved Publik credential. `PUBLIK_APP_TOKEN` overrides the packaged public app token. The current intended listing slug is `publik-code`; confirm it against the actual listing before issuing a token.
- On HTTP 402, the app shows Publik's message and its one top-up/claim link. Wallet refresh does not run a model call.
- Requests are limited to under 4 MB. Tier context/output limits use conservative 32,768/8,192 defaults until Publik documents them.

Builder setup: follow [Publik's integration skill](https://publikhq.com/skills/api.md) to obtain the public token using browser authorization. Follow [the publishing skill](https://publikhq.com/skills/publish.md) for the listing. Never paste private keys into chat or source files.

## How it works

```text
Electron account / project launcher
  ├─ Publik provisioning and balance (main process)
  ├─ OpenCode web UI (isolated sandboxed renderer)
  └─ OpenCode engine (local authenticated process)
       ├─ reads, edits, shell tools on your laptop
       └─ authenticated loopback model adapter
            └─ Publik API or your own provider
```

The local adapter keeps the actual upstream key out of OpenCode's configuration and web UI, forwards streaming responses, and captures Publik metering/errors. OpenCode gets a temporary local credential. Both services listen only on loopback with random authentication credentials. Engine state lives in the app's own data directory, separate from an existing OpenCode installation. Project-level OpenCode configuration and third-party plugins are disabled in this initial release; repository instructions may still apply. Tool approval is a user control, not an OS filesystem sandbox.

Sessions and coding history remain on your computer. Prompts and relevant project content are sent to the selected model provider. Publik describes upstream retention in its [developer documentation](https://publikhq.com/developers). User-supplied keys can be saved using Electron's OS-backed encrypted storage or kept only for the current app session. Windows inherits the user's profile ACLs for Publik credentials; POSIX credentials use mode 0600.

## Development and verification

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run test:desktop
```

The smoke test starts the real pinned OpenCode executable against a local OpenAI-compatible mock. It checks authenticated startup, UI serving, streaming, an actual read tool, and the tool-result round trip. These tests do not spend Publik credit or prove live Publik compatibility.

```sh
npm run package:mac   # run on macOS; DMG and ZIP
npm run package:win   # run on Windows; NSIS installer
```

Build each package on its target platform so it contains the correct OpenCode executable. The build workflow uploads platform artifacts; release publishing is a separate step. macOS artifacts are unsigned and not notarized.

## License and credits

MIT. OpenCode is MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Publik integration reference is attributed in its source. Electron and other dependencies retain their respective licenses.
