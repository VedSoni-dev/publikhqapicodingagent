import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APP_SLUG, APP_VERSION, DEFAULT_BASE_URL, MODELS, balanceLine, credentialPath, readCredential, resolveProvider, selfTest, topUpUrlFrom402 } from '../src/publik.js';

function isolate(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'publik-test-'));
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, PUBLIK_APP_TOKEN: process.env.PUBLIK_APP_TOKEN, PUBLIK_API_KEY: process.env.PUBLIK_API_KEY, PUBLIK_API_BASE_URL: process.env.PUBLIK_API_BASE_URL };
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config'); process.env.LOCALAPPDATA = join(home, 'AppData');
  delete process.env.PUBLIK_API_KEY; delete process.env.PUBLIK_API_BASE_URL;
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('defaults to the Publik API with the balanced tier', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://publikhq.com/api/v1');
  assert.equal(MODELS.balanced, 'publik-balanced');
  assert.equal(APP_SLUG, 'publik-code');
});

test('provider resolution: own key > env > credential file > consent', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  assert.equal(resolveProvider().kind, 'needs_consent');
  assert.equal(resolveProvider({ baseURL: 'https://example.com/v1', apiKey: 'sk-own' }).kind, 'own');
  process.env.PUBLIK_API_KEY = 'pk_env';
  const env = resolveProvider();
  assert.equal(env.kind, 'publik');
  assert.equal(env.kind === 'publik' && env.baseURL, DEFAULT_BASE_URL);
});

test('self-test reports a missing app token instead of crashing', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'not-a-token';
  assert.equal(await selfTest(), 'publik self-test: failed: This build has no publik API app token. Use your own key for now.');
});

test('self-test provisions via POST /installs and stores the key with mode 0600', async t => {
  isolate(t);
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  let sent: any;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, `${DEFAULT_BASE_URL}/installs`);
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ key: 'pk_live_test', install_id: 'abcdef12-3456', claim_url: 'https://publikhq.com/claim/x', claim_state: 'anonymous', balance_micros: 0 }), { status: 201 });
  }) as typeof fetch;
  assert.equal(await selfTest(), `publik self-test: ok publik-code ${APP_VERSION} (install abcdef12)`);
  assert.equal(sent.app_slug, 'publik-code');
  assert.equal(sent.app_token, 'pat_test');
  assert.equal(readCredential()?.key, 'pk_live_test');
  if (process.platform !== 'win32') assert.equal(statSync(credentialPath()).mode & 0o777, 0o600);
  assert.equal(resolveProvider().kind, 'publik');
});

test('402 yields the message and exactly one top-up link', () => {
  assert.deepEqual(topUpUrlFrom402({ error: { message: 'Out of balance', top_up_url: 'https://publikhq.com/add' } }), { message: 'Out of balance', url: 'https://publikhq.com/add' });
  assert.deepEqual(topUpUrlFrom402(null), { message: 'Not enough publik API balance.', url: null });
  assert.equal(balanceLine(0), '$0.00 · link this computer for $0.05 of free use');
  assert.equal(balanceLine(50_000, 'claimed'), '$0.05 of publik balance');
});
