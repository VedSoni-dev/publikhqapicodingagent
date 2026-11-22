import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APP_SLUG, APP_VERSION, DEFAULT_BASE_URL, MODELS, USES_AI, credentialPath, ensureSignedIn, readCredential, resolveProvider, selfTest, setChoice, topUpUrlFrom402, type GateScreen, type GateUI } from '../src/publik.js';

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'LOCALAPPDATA', 'PUBLIK_APP_TOKEN', 'PUBLIK_API_KEY', 'PUBLIK_API_BASE_URL', 'DO_NOT_TRACK', 'PUBLIK_TELEMETRY', 'PUBLIK_SELF_TEST'] as const;

function isolate(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'publik-test-'));
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config'); process.env.LOCALAPPDATA = join(home, 'AppData');
  for (const k of ['PUBLIK_API_KEY', 'PUBLIK_API_BASE_URL', 'DO_NOT_TRACK', 'PUBLIK_TELEMETRY', 'PUBLIK_SELF_TEST']) delete process.env[k];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

const wallet = (claim_state: 'anonymous' | 'claimed') => ({
  claim_state, claim_url: 'https://publikhq.com/claim/x', account: claim_state === 'claimed' ? { handle: 'tester' } : null,
  plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: 'https://publikhq.com/wallet', linked_at: null,
});

/** A stand-in for publikhq.com: /installs, /wallet (anonymous until `claimAfter` reads), /telemetry. */
function fakePublik(claimAfter = 0) {
  const seen: { url: string; auth: string | null; body: any }[] = [];
  let walletReads = 0;
  const fetchMock = (async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get('authorization');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, auth, body });
    if (url === `${DEFAULT_BASE_URL}/installs`) return new Response(JSON.stringify({ key: 'pk_live_test', install_id: 'abcdef12-3456', claim_url: 'https://publikhq.com/claim/x' }), { status: 201 });
    if (url === `${DEFAULT_BASE_URL}/wallet`) return new Response(JSON.stringify(wallet(walletReads++ >= claimAfter ? 'claimed' : 'anonymous')), { status: 200 });
    if (url === `${DEFAULT_BASE_URL}/telemetry`) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { seen, fetchMock };
}

test('slug, tier models and the publik base URL', () => {
  assert.equal(APP_SLUG, 'publik-code');
  assert.equal(USES_AI, true);
  assert.equal(DEFAULT_BASE_URL, 'https://publikhq.com/api/v1');
  assert.equal(MODELS.balanced, 'publik-balanced');
});

test('self-test reports a missing app token instead of crashing', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'not-a-token';
  assert.equal(await selfTest(), 'publik self-test: failed: This build has no publik app token. Ask the developer for a new build.');
});

test('self-test provisions via POST /api/v1/installs, reads /wallet, stores the key with mode 0600', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  const { seen, fetchMock } = fakePublik();
  globalThis.fetch = fetchMock;
  assert.equal(await selfTest(), `publik self-test: ok publik-code ${APP_VERSION}`);
  assert.equal(seen[0]!.body.app_slug, 'publik-code');
  assert.equal(seen[0]!.body.app_token, 'pat_test');
  assert.equal(seen[1]!.auth, 'Bearer pk_live_test');
  assert.equal(readCredential()?.key, 'pk_live_test');
  if (process.platform !== 'win32') assert.equal(statSync(credentialPath()).mode & 0o777, 0o600);
});

test('the gate shows Sign in with publik until claimed, asks how to pay, then counts the launch', async t => {
  const home = isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  const { seen, fetchMock } = fakePublik(1); // first /wallet read: anonymous, then claimed
  globalThis.fetch = fetchMock;
  const shown: GateScreen[] = []; const opened: string[] = [];
  const ui: GateUI = {
    async show(screen) { shown.push(screen); return screen.id === 'sign_in' ? 'sign_in' : 'own_key'; },
    openUrl(url) { opened.push(url); },
  };
  const gate = await ensureSignedIn(ui);
  assert.deepEqual(shown.map(s => s.id), ['sign_in', 'choose']);
  assert.equal(shown[0]!.buttons[0]!.label, 'Sign in with publik');
  assert.deepEqual(shown[1]!.buttons.map(b => b.label), ['Get a plan', 'Use my own key']);
  assert.deepEqual(opened, ['https://publikhq.com/claim/x']);
  assert.equal(gate.choice, 'own_key');
  assert.equal(readCredential()?.choice, 'own_key');
  await new Promise(r => setTimeout(r, 50)); // telemetry is fire-and-forget
  const ping = seen.find(s => s.url === `${DEFAULT_BASE_URL}/telemetry`);
  assert.ok(ping, 'app_opened was sent');
  assert.equal(ping!.body.event, 'app_opened');
  assert.equal(ping!.body.app, 'publik-code');
  assert.equal(ping!.auth, 'Bearer pk_live_test');
  for (const k of Object.keys(ping!.body)) assert.ok(['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch'].includes(k), `no extra telemetry field: ${k}`);
  const tel = JSON.parse(readFileSync(join(home, process.platform === 'darwin' ? 'Library/Application Support' : process.platform === 'win32' ? 'AppData' : '.config', 'publik', 'telemetry.json'), 'utf8'));
  assert.equal(tel.install_id, ping!.body.install_id);
});

test('provider: the stored choice decides; the own key is used only when chosen', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  globalThis.fetch = fakePublik().fetchMock;
  await selfTest(); // provisions a credential
  const ownKey = { baseURL: 'https://example.com/v1', apiKey: 'sk-own' };
  assert.equal(resolveProvider().kind, 'needs_own_key');
  assert.equal(resolveProvider(ownKey).kind, 'own');
  setChoice('publik');
  const p = resolveProvider(ownKey);
  assert.equal(p.kind, 'publik');
  assert.equal(p.kind === 'publik' && p.apiKey, 'pk_live_test');
  setChoice('own_key');
  assert.equal(resolveProvider(ownKey).kind, 'own');
});

test('402 yields the message and exactly one top-up link', () => {
  assert.deepEqual(topUpUrlFrom402({ error: { message: 'Out of balance', top_up_url: 'https://publikhq.com/add' } }), { message: 'Out of balance', url: 'https://publikhq.com/add' });
  assert.deepEqual(topUpUrlFrom402(null), { message: 'Not enough publik API balance.', url: null });
});
