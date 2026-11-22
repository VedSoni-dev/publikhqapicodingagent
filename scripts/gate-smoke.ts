/** Electron smoke for the Sign in with publik gate, against a local stand-in for publikhq.com (nothing leaves
 *  the machine): a fresh computer provisions an install, sees "Sign in with publik" before any app window,
 *  moves on by itself once the account is claimed (the 3-second check), chooses how to pay for AI, and only
 *  then gets the app's own window. Closing the gate quits the app. */
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'publik-code-gate-')));
let claimed = false; const hits: string[] = [];
const publik = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  hits.push(`${req.method} ${req.url} ${req.headers.authorization ? 'bearer' : '-'}`);
  res.setHeader('content-type', 'application/json');
  // claim_url is not a publikhq.com https link, so the app's safeLink() refuses to open a real browser.
  if (req.url === '/api/v1/installs') { res.writeHead(201); return res.end(JSON.stringify({ key: 'pk_gate_not_real', install_id: '22222222-2222-4222-8222-222222222222', claim_url: 'http://127.0.0.1/claim' })); }
  if (req.url === '/api/v1/wallet') {
    res.writeHead(200);
    return res.end(JSON.stringify({ claim_state: claimed ? 'claimed' : 'anonymous', claim_url: 'http://127.0.0.1/claim', account: claimed ? { handle: 'smoke' } : null, plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: 'http://127.0.0.1/wallet', linked_at: null }));
  }
  if (req.url === '/api/v1/telemetry') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end('{}');
});
await new Promise<void>(r => publik.listen(0, '127.0.0.1', r));
const port = (publik.address() as any).port;

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
for (const k of ['ELECTRON_RUN_AS_NODE', 'PUBLIK_API_KEY', 'PUBLIK_SELF_TEST', 'DO_NOT_TRACK', 'PUBLIK_TELEMETRY']) delete env[k];
Object.assign(env, { HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'), LOCALAPPDATA: join(temp, 'AppData'),
  PUBLIK_ORIGIN: `http://127.0.0.1:${port}`, PUBLIK_APP_TOKEN: 'pat_gate_smoke_not_real', PUBLIK_CODE_TEST: '1' });
const executablePath = process.env.PUBLIK_CODE_PACKAGED_EXECUTABLE;
const launch = () => electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });

let app = await launch();
try {
  const gate = await app.firstWindow();
  await expect(gate.getByRole('heading', { name: 'Sign in with publik' })).toBeVisible();
  await expect(gate.getByText('This app uses your publik account.')).toBeVisible();
  if (app.windows().length !== 1) throw new Error('An app window opened before the sign-in');
  await gate.getByRole('link', { name: 'Sign in with publik' }).click({ noWaitAfter: true }); // the gate cancels the navigation itself
  await expect(gate.getByText('Waiting for you to sign in in your browser.')).toBeVisible();
  claimed = true; // the person finished signing in in their browser
  await expect(gate.getByRole('heading', { name: 'Choose how to pay for AI' })).toBeVisible({ timeout: 10_000 });
  await gate.getByRole('link', { name: 'Use my own key' }).click({ noWaitAfter: true });
  const main = await app.waitForEvent('window');
  await expect(main.getByRole('heading', { name: 'Make something worth shipping.' })).toBeVisible();
  await expect.poll(() => app.windows().length).toBe(1);
  await expect.poll(() => hits.some(h => h === 'POST /api/v1/telemetry bearer')).toBe(true);
} finally { await app.close(); }

// Signed out on publik's side again: the gate comes back, and closing it quits the app.
claimed = false;
app = await launch();
try {
  const gate = await app.firstWindow();
  await expect(gate.getByRole('heading', { name: 'Sign in with publik' })).toBeVisible(); // signed out again on the server
  const closed = app.waitForEvent('close');
  await gate.close();
  await closed;
} finally { await app.close().catch(() => {}); }

publik.closeAllConnections(); publik.close();
await rm(temp, { recursive: true, force: true });
console.log(`PASS: gate before the first window, auto-advance after sign-in, plan choice, app window, app_opened with the install key, close quits. (${hits.length} publik requests, all local)`);
