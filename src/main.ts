import { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } from 'electron';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, writeSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, safeLink, validateBaseURL, type GatewayEvent } from './gateway';
import { startEngine, TIERS, type Engine, type EngineEvent, type Tier } from './engine';
import { APP_SLUG, APP_VERSION, DISCLOSURE, provision, resolveProvider, readCredential, credentialPath, selfTest } from './publik';

// Builder check (https://publikhq.com/skills/setup.md): first thing at startup, print one line and exit.
const SELF_TEST = Boolean(process.env.PUBLIK_SELF_TEST);
if (SELF_TEST) {
  // writeSync: an async pipe write would be lost when app.exit() tears the process down.
  void selfTest().then(line => { try { writeSync(1, `${line}\n`); } catch {} app.exit(0); });
}

app.setName('Publik Code');
let window: BrowserWindow;
let engine: Engine | undefined;
let tier: Tier = 'publik-balanced';
const pending = new Map<string, { tool: string; resolve: (ok: boolean) => void }>();
const alwaysAllow = new Set<string>();
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
    payment, workspace, running: Boolean(engine), busy, notice: lastNotice, tier,
  };
}
function notify() { if (window && !window.isDestroyed()) window.webContents.send('state', publicState()); }
function send(channel: string, value?: unknown) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function showHome() { window.show(); notify(); send('home'); }
function showWorkspace() { if (engine) { notify(); send('workspace'); } }
function emit(event: EngineEvent | { type: 'approval'; id: string; tool: string; input: unknown }) {
  if (event.type === 'error') event = { ...event, message: cleanMessage(event.message) };
  send('engine', event);
}
async function stopEngine() {
  for (const p of pending.values()) p.resolve(false);
  pending.clear(); alwaysAllow.clear();
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
async function launch(selectedTier: string, mode: 'continue' | 'new' = 'continue', folder?: string) {
  if (busy) throw new Error('The coding engine is already starting.');
  if (!TIERS.includes(selectedTier as Tier)) throw new Error('Choose a valid Publik tier.');
  const provider = resolveProvider(own);
  if (provider.kind === 'needs_consent') throw new Error('Connect Publik or your own API first.');
  let target = folder;
  if (!target) {
    const selected = process.env.PUBLIK_CODE_TEST_WORKSPACE && process.env.PUBLIK_CODE_TEST === '1'
      ? { canceled: false, filePaths: [process.env.PUBLIK_CODE_TEST_WORKSPACE] }
      : await dialog.showOpenDialog(window, { title: 'Open a project you trust', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return publicState();
    target = selected.filePaths[0];
    if (engine) {
      const result = await dialog.showMessageBox(window, { type: 'question', message: 'Stop the current coding session and open another project?', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return publicState();
    }
  }
  busy = true; notify();
  try {
    await stopEngine();
    workspace = realpathSync(target);
    tier = selectedTier as Tier;
    gateway = await startGateway({ baseURL: provider.baseURL, apiKey: provider.apiKey, publik: provider.kind === 'publik', onEvent: event => {
      if (event.type === 'meter') meter = event;
      else payment = { ...event, message: cleanMessage(event.message) };
      notify();
    } });
    engine = await startEngine({
      cwd: workspace, dataDir: app.getPath('userData'), gatewayURL: gateway.baseURL, gatewayToken: gateway.token,
      provider: provider.kind === 'own' ? 'own' : 'publik', model: provider.kind === 'own' ? own!.model : tier, session: mode,
      approve: request => {
        if (alwaysAllow.has(request.tool)) return Promise.resolve(true);
        return new Promise<boolean>(resolve => { pending.set(request.id, { tool: request.tool, resolve }); emit({ type: 'approval', ...request }); });
      },
      onEvent: emit,
    });
    lastNotice = null;
    send('history', engine.history());
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
  if (SELF_TEST) return;
  loadOwn();
  window = new BrowserWindow({ width: 1240, height: 840, minWidth: 720, minHeight: 640, title: 'Publik Code', backgroundColor: '#f6f4ef', webPreferences: { preload: join(root, 'dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    const link = safeLink(url, kind !== 'source' && (kind !== 'payment' || resolveProvider(own).kind === 'publik'));
    if (!link) throw new Error('No valid account link is available. Open your Publik dashboard.');
    await shell.openExternal(link);
  });
  register('launch', (selected: string) => launch(selected));
  register('new-chat', async () => { if (!workspace) throw new Error('Open a project first.'); return launch(tier, 'new', workspace); });
  register('prompt', async (text: unknown) => {
    if (!engine) throw new Error('Open a project first.');
    if (typeof text !== 'string' || !text.trim()) return publicState();
    payment = null; notify();
    void engine.prompt(text.slice(0, 200_000));
    return publicState();
  });
  register('abort', async () => { for (const p of pending.values()) p.resolve(false); pending.clear(); await engine?.abort(); return publicState(); });
  register('approve', async (id: unknown, ok: unknown, always: unknown) => {
    const entry = typeof id === 'string' ? pending.get(id) : undefined;
    if (!entry) return publicState();
    pending.delete(id as string);
    // "Allow for this session" covers later calls of the same tool until the workspace stops.
    if (ok === true && always === true) alwaysAllow.add(entry.tool);
    entry.resolve(ok === true);
    return publicState();
  });
  register('set-tier', async (next: unknown) => {
    if (!TIERS.includes(next as Tier)) throw new Error('Choose a valid Publik tier.');
    tier = next as Tier;
    if (engine && resolveProvider(own).kind === 'publik') await engine.setTier(tier);
    return publicState();
  });
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
