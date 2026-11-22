import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, safeStorage, session } from 'electron';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, safeLink, validateBaseURL, type GatewayEvent } from './gateway';
import { startRuntime, runtimeConfig, TIERS } from './runtime';
import { APP_SLUG, APP_VERSION, ensureSignedIn, resolveProvider, readCredential, setChoice, type GateAction, type GateScreen, type GateUI } from './publik';

/** Shown next to "Connect Publik" on the home screen. */
const DISCLOSURE =
  "Publik API runs this app's AI with no key to paste, priced per use in dollars from your publik balance or plan. " +
  "Your prompts go through publik's servers to the model. You can switch to your own key at any time.";

app.setName('Publik Code');
let window: BrowserWindow;
let view: WebContentsView | undefined;
let engine: Awaited<ReturnType<typeof startRuntime>> | undefined;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let busy = false;
let quitting = false;
let workspace: string | null = null;
let own: { apiKey: string; baseURL: string; model: string } | null = null;
let meter: Extract<GatewayEvent, { type: 'meter' }> | null = null;
let payment: Extract<GatewayEvent, { type: 'payment' }> | null = null;
let walletBalance: number | null = null;
let accountLink: string | null = null;
let claimed = false;
let lastNotice: string | null = null;
const root = app.getAppPath();
const homeURL = pathToFileURL(join(root, 'src/renderer/index.html')).href;
const cleanMessage = (message: string) => message.replace(/\b(?:pk_|pat_|pbt_)[A-Za-z0-9_-]+/g, '[redacted]');
/** Sign in with publik (https://publikhq.com/sdk/publik.ts.md), drawn in a small window before the app's own.
 *  Not dialog.showMessageBox: on macOS a parentless message box blocks the main process, which would stop
 *  the gate's 3-second sign-in check until the user clicked again. Closing this window quits the app. */
let gateWindow: BrowserWindow | null = null;
let gatePassed = false;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function gateHtml(screen: GateScreen): string {
  const buttons = screen.buttons.map((b, i) => `<a class="${i ? 'b' : 'b p'}" href="https://publik-gate.invalid/${i}">${esc(b.label)}</a>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Publik Code</title><style>
:root{color-scheme:light dark}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f4ef;color:#1c1b19;display:grid;place-items:center;min-height:100vh}
main{max-width:360px;padding:32px 28px}small{color:#6d6a63;letter-spacing:.04em;text-transform:uppercase;font-size:11px}h1{font-size:22px;margin:4px 0 10px}
p{margin:0 0 12px;color:#3b3934}.note{color:#6d6a63;font-size:13px}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.b{display:inline-block;padding:9px 16px;border-radius:9px;border:1px solid #cfcac0;color:inherit;text-decoration:none;font-weight:600}.p{background:#1c1b19;color:#f6f4ef;border-color:#1c1b19}
@media (prefers-color-scheme:dark){body{background:#171614;color:#f1eee8}p{color:#d6d2ca}.note,small{color:#9c978d}.b{border-color:#46433d}.p{background:#f1eee8;color:#171614;border-color:#f1eee8}}
</style><main><small>Publik Code</small><h1>${esc(screen.title)}</h1><p>${esc(screen.body)}</p>${screen.note ? `<p class="note">${esc(screen.note)}</p>` : ''}<div class="row">${buttons}</div></main>`;
}
const gateUI: GateUI = {
  show(screen, signal) {
    return new Promise<GateAction>(resolve => {
      if (!gateWindow || gateWindow.isDestroyed()) {
        gateWindow = new BrowserWindow({ width: 480, height: 380, resizable: false, fullscreenable: false, title: 'Publik Code', backgroundColor: '#f6f4ef', show: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false } });
        gateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        gateWindow.once('ready-to-show', () => gateWindow?.show());
        gateWindow.on('closed', () => { gateWindow = null; if (!gatePassed) app.exit(0); });
      }
      const contents = gateWindow.webContents;
      const onNavigate = (event: Electron.Event, url: string) => {
        event.preventDefault();
        const index = Number(/^https:\/\/publik-gate\.invalid\/(\d+)$/.exec(url)?.[1] ?? -1);
        const button = screen.buttons[index];
        if (button && !signal.aborted) { contents.off('will-navigate', onNavigate); resolve(button.action); }
      };
      contents.on('will-navigate', onNavigate);
      signal.addEventListener('abort', () => contents.off('will-navigate', onNavigate), { once: true }); // the gate moved on
      void gateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(gateHtml(screen))}`);
    });
  },
  openUrl(url) { const link = safeLink(url); if (link) void shell.openExternal(link); },
};
const ownPath = () => join(app.getPath('userData'), 'own-provider.enc');
function loadOwn() {
  try {
    if (safeStorage.isEncryptionAvailable() && existsSync(ownPath())) {
      const data = JSON.parse(safeStorage.decryptString(readFileSync(ownPath())));
      if (typeof data.apiKey === 'string' && typeof data.model === 'string') own = { ...data, baseURL: validateBaseURL(data.baseURL) };
    }
  } catch { lastNotice = 'Your saved API connection could not be unlocked. Enter it again.'; }
}
function publicState() {
  const provider = resolveProvider(own);
  const c = readCredential();
  const tokenReady = Boolean(process.env.PUBLIK_APP_TOKEN || existsSync(join(root, 'publik-app-token.txt')));
  return {
    version: APP_VERSION, slug: APP_SLUG, disclosure: DISCLOSURE, tokenReady,
    provider: provider.kind, own: own ? { baseURL: own.baseURL, model: own.model } : null,
    balanceMicros: walletBalance,
    balanceHeader: meter?.balance ?? null, chargeMicros: meter?.charge ?? null,
    cost: null,
    linked: claimed,
    accountLink: accountLink ?? safeLink(c?.claim_url),
    payment, workspace, running: Boolean(engine), busy, notice: lastNotice,
  };
}
function notify() { if (window && !window.isDestroyed()) window.webContents.send('state', publicState()); }
function bounds() {
  if (!view || !window) return;
  const [width, height] = window.getContentSize();
  view.setBounds({ x: 0, y: 72, width, height: Math.max(0, height - 72) });
}
function showHome() { view?.setVisible(false); window.show(); notify(); window.webContents.send('home'); }
function showWorkspace() { if (view) { view.setVisible(true); bounds(); view.webContents.focus(); window.webContents.send('workspace'); } }
async function stopEngine() {
  const oldView = view; view = undefined;
  if (oldView) { window.contentView.removeChildView(oldView); oldView.webContents.close(); }
  const oldEngine = engine; engine = undefined;
  await oldEngine?.stop();
  const oldGateway = gateway; gateway = undefined;
  await oldGateway?.close();
  notify();
}
async function refreshWallet() {
  const provider = resolveProvider(own);
  if (provider.kind !== 'publik') return publicState();
  const response = await fetch(`${validateBaseURL(provider.baseURL)}/wallet`, { headers: { authorization: `Bearer ${provider.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(typeof body.error?.message === 'string' ? body.error.message : 'Could not refresh your Publik balance.');
  const balance = body.balance_micros ?? body.wallet?.balance_micros;
  if (typeof balance === 'number' && Number.isFinite(balance)) walletBalance = balance;
  const balanceHeader = response.headers.get('x-publik-balance');
  if (balanceHeader) meter = { type: 'meter', balance: balanceHeader, charge: meter?.charge ?? null, usage: null, budget: null, reset: null };
  const state = body.claim_state ?? body.install?.claim_state;
  if (state === 'claimed') claimed = true;
  accountLink = safeLink(body.top_up_url ?? body.add_credit_url ?? body.wallet?.add_credit_url) ?? accountLink;
  payment = null;
  notify();
  return publicState();
}
async function launch(tier: string) {
  if (busy) throw new Error('The coding engine is already starting.');
  if (!TIERS.includes(tier as any)) throw new Error('Choose a valid Publik tier.');
  const provider = resolveProvider(own);
  if (provider.kind === 'needs_own_key') throw new Error('Connect Publik or your own API first.');
  const selected = process.env.PUBLIK_CODE_TEST_WORKSPACE && process.env.PUBLIK_CODE_TEST === '1'
    ? { canceled: false, filePaths: [process.env.PUBLIK_CODE_TEST_WORKSPACE] }
    : await dialog.showOpenDialog(window, { title: 'Open a project you trust', properties: ['openDirectory', 'createDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return publicState();
  if (engine) {
    const result = await dialog.showMessageBox(window, { type: 'question', message: 'Stop the current coding session and open another project?', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return publicState();
  }
  busy = true; notify();
  try {
    await stopEngine();
    workspace = realpathSync(selected.filePaths[0]);
    gateway = await startGateway({ baseURL: provider.baseURL, apiKey: provider.apiKey, publik: provider.kind === 'publik', onEvent: event => {
      if (event.type === 'meter') meter = event;
      else { payment = { ...event, message: cleanMessage(event.message) }; showHome(); }
      notify();
    } });
    const binary = join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'runtime', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    engine = await startRuntime({ binary, cwd: workspace, dataDir: join(app.getPath('userData'), 'engine'), config: runtimeConfig(gateway.baseURL, gateway.token, tier, provider.kind === 'own' ? own?.model : undefined), onExit: () => {
      if (!quitting) { lastNotice = 'The coding engine stopped. You can reopen your project and resume the saved session.'; showHome(); void stopEngine(); }
    } });
    const currentEngine = engine;
    const engineSession = session.fromPartition(`publik-engine-${Date.now()}`);
    engineSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    engineSession.setPermissionCheckHandler(() => false);
    engineSession.webRequest.onBeforeSendHeaders({ urls: [`${engine.url}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: currentEngine.auth, 'x-opencode-directory': workspace! } });
    });
    view = new WebContentsView({ webPreferences: { session: engineSession, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.webContents.setWindowOpenHandler(({ url }) => { const link = safeLink(url, false); if (link) void shell.openExternal(link); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== currentEngine.url) { event.preventDefault(); const link = safeLink(url, false); if (link) void shell.openExternal(link); } });
    window.contentView.addChildView(view);
    bounds();
    const folder = Buffer.from(workspace).toString('base64url');
    await view.webContents.loadURL(`${engine.url}/${folder}/session`);
    lastNotice = null;
    showWorkspace();
  } catch (error) { await stopEngine(); throw error; }
  finally { busy = false; notify(); }
  return publicState();
}
function register(channel: string, action: (...args: any[]) => any) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== homeURL) throw new Error('Untrusted sender.');
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: cleanMessage(error instanceof Error ? error.message : 'The action could not be completed.') }; }
  });
}
app.whenReady().then(async () => {
  // Sign in with publik before any window. PUBLIK_SELF_TEST=1 prints the self-test line here and exits.
  // ensureSignedIn() also starts usage counting (app_opened, then active_session every 30 minutes).
  const gate = await ensureSignedIn(gateUI);
  claimed = gate.wallet.claim_state === 'claimed';
  walletBalance = gate.wallet.balance_micros;
  accountLink = safeLink(gate.wallet.top_up_url);
  loadOwn();
  window = new BrowserWindow({ width: 1240, height: 840, minWidth: 720, minHeight: 640, title: 'Publik Code', backgroundColor: '#f6f4ef', webPreferences: { preload: join(root, 'dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  gatePassed = true; gateWindow?.destroy(); // the app's window exists now, so closing the gate does not quit
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('resize', bounds);
  window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
  register('state', publicState);
  register('provision', async (consent: boolean) => {
    if (consent !== true) throw new Error('Accept the Publik disclosure to continue.');
    if (engine) throw new Error('Stop the current workspace before changing API connections.');
    setChoice('publik');
    return publicState();
  });
  register('refresh', refreshWallet);
  register('save-own', async (data: any) => {
    if (engine) throw new Error('Stop the current workspace before changing API connections.');
    if (!data || typeof data.apiKey !== 'string' || !data.apiKey.trim() || typeof data.model !== 'string' || !data.model.trim() || data.model.length > 200) throw new Error('Enter a key and a model ID.');
    const next = { baseURL: validateBaseURL(data.baseURL), apiKey: data.apiKey.trim(), model: data.model.trim() };
    if (data.remember && !safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Uncheck Remember to use this key for this session only.');
    own = next;
    setChoice('own_key');
    const { rmSync } = await import('node:fs');
    if (data.remember) writeFileSync(ownPath(), safeStorage.encryptString(JSON.stringify(own)), { mode: 0o600 });
    else rmSync(ownPath(), { force: true });
    return publicState();
  });
  register('use-publik', async () => {
    if (engine) throw new Error('Stop the current workspace before changing API connections.');
    own = null; setChoice('publik'); const { rmSync } = await import('node:fs'); rmSync(ownPath(), { force: true }); return publicState();
  });
  register('open-link', async (kind: string) => {
    const state = publicState();
    const url = kind === 'payment' ? state.payment?.url : kind === 'account' ? state.accountLink : kind === 'dashboard' ? 'https://publikhq.com/dashboard/api' : kind === 'source' ? 'https://github.com/VedSoni-dev/publikhqapicodingagent' : null;
    const link = safeLink(url, kind !== 'source' && (kind !== 'payment' || resolveProvider(own).kind === 'publik'));
    if (!link) throw new Error('No valid account link is available. Open your Publik dashboard.');
    await shell.openExternal(link);
  });
  register('launch', launch);
  register('home', showHome);
  register('resume', showWorkspace);
  register('stop', async () => { await stopEngine(); showHome(); return publicState(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    { label: 'File', submenu: [{ label: 'Account & usage', accelerator: 'CmdOrCtrl+,', click: showHome }, { label: 'Back to workspace', accelerator: 'CmdOrCtrl+Shift+O', click: showWorkspace }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  void window.loadURL(homeURL);
});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void stopEngine().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
