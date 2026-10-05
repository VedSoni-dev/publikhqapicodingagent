import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, safeStorage, session } from 'electron';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, safeLink, validateBaseURL, type GatewayEvent } from './gateway';
import { startRuntime, runtimeConfig, TIERS } from './runtime';
import { APP_SLUG, APP_VERSION, DISCLOSURE, provision, resolveProvider, readCredential, credentialPath } from './publik';

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
  const c = provider.kind === 'publik' ? provider.credential : null;
  const tokenReady = Boolean(process.env.PUBLIK_APP_TOKEN || existsSync(join(root, 'publik-app-token.txt')));
  return {
    version: APP_VERSION, slug: APP_SLUG, disclosure: DISCLOSURE, tokenReady,
    provider: provider.kind, own: own ? { baseURL: own.baseURL, model: own.model } : null,
    balanceMicros: walletBalance ?? c?.balance_micros ?? null,
    balanceHeader: meter?.balance ?? null, chargeMicros: meter?.charge ?? null,
    cost: c?.cost_sentence ?? null,
    linked: claimed || c?.claim_state === 'claimed',
    accountLink: accountLink ?? safeLink(c?.claim_state === 'claimed' ? c?.add_credit_url : c?.claim_url),
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
  accountLink = safeLink(body.add_credit_url ?? body.wallet?.add_credit_url) ?? accountLink;
  payment = null;
  notify();
  return publicState();
}
async function launch(tier: string) {
  if (busy) throw new Error('The coding engine is already starting.');
  if (!TIERS.includes(tier as any)) throw new Error('Choose a valid Publik tier.');
  const provider = resolveProvider(own);
  if (provider.kind === 'needs_consent') throw new Error('Connect Publik or your own API first.');
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
app.whenReady().then(() => {
  loadOwn();
  window = new BrowserWindow({ width: 1240, height: 840, minWidth: 720, minHeight: 640, title: 'Publik Code', backgroundColor: '#f6f4ef', webPreferences: { preload: join(root, 'dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('resize', bounds);
  window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
  register('state', publicState);
  register('provision', async (consent: boolean) => {
    if (consent !== true) throw new Error('Accept the Publik disclosure to continue.');
    if (resolveProvider().kind === 'needs_consent') await provision();
    return publicState();
  });
  register('refresh', refreshWallet);
  register('save-own', async (data: any) => {
    if (engine) throw new Error('Stop the current workspace before changing API connections.');
    if (!data || typeof data.apiKey !== 'string' || !data.apiKey.trim() || typeof data.model !== 'string' || !data.model.trim() || data.model.length > 200) throw new Error('Enter a key and a model ID.');
    const next = { baseURL: validateBaseURL(data.baseURL), apiKey: data.apiKey.trim(), model: data.model.trim() };
    if (data.remember && !safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Uncheck Remember to use this key for this session only.');
    own = next;
    const { rmSync } = await import('node:fs');
    if (data.remember) writeFileSync(ownPath(), safeStorage.encryptString(JSON.stringify(own)), { mode: 0o600 });
    else rmSync(ownPath(), { force: true });
    return publicState();
  });
  register('use-publik', async () => {
    if (engine) throw new Error('Stop the current workspace before changing API connections.');
    own = null; const { rmSync } = await import('node:fs'); rmSync(ownPath(), { force: true }); return publicState();
  });
  register('open-link', async (kind: string) => {
    const state = publicState();
    const url = kind === 'payment' ? state.payment?.url : kind === 'account' ? state.accountLink : kind === 'dashboard' ? 'https://publikhq.com/dashboard/api' : kind === 'source' ? 'https://github.com/VedSoni-dev/publikhqapicodingagent' : null;
    const link = safeLink(url, kind !== 'source');
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
