import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import test, { type TestContext } from 'node:test';
import { MAX_BODY, safeLink, startGateway, validateBaseURL, type GatewayEvent } from '../src/gateway.js';

async function fixture(t: TestContext, handler: RequestListener, publik = true) {
  const upstream = createServer(handler);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const events: GatewayEvent[] = [];
  const gateway = await startGateway({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'test-upstream-key', publik, onEvent: event => events.push(event),
  });
  t.after(async () => {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const request = (body: string, init: RequestInit = {}) => fetch(`${gateway.baseURL}/chat/completions`, {
    method: 'POST', body,
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    ...init,
  });
  return { gateway, events, request };
}

test('gateway requires its own bearer token before accepting any endpoint', async t => {
  let calls = 0;
  const { gateway, request } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  assert.match(gateway.token, /^[a-f0-9]{64}$/);
  for (const authorization of ['', 'Bearer test-upstream-key', `Bearer ${'0'.repeat(64)}`]) {
    const response = await request('{}', { headers: { authorization } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { message: 'Unauthorized' } });
  }
  assert.equal(calls, 0);
});

test('only POST /v1/chat/completions is exposed', async t => {
  let calls = 0;
  const { gateway } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  for (const [method, path] of [['GET', '/v1/chat/completions'], ['POST', '/v1/models'], ['POST', '/v1/chat/completions?extra=1']]) {
    const response = await fetch(`${new URL(gateway.baseURL).origin}${path}`, {
      method, headers: { authorization: `Bearer ${gateway.token}` },
    });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  assert.equal(calls, 0);
});

test('Publik accepts all three tiers and rejects vendor model IDs and malformed JSON', async t => {
  let calls = 0;
  const { request } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  for (const model of ['publik-fast', 'publik-balanced', 'publik-smart']) {
    const response = await request(JSON.stringify({ model }));
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (const body of ['{', 'null', '[]', '"publik-fast"', '{}', '{"model":"openai/gpt-5"}', '{"model":"claude-sonnet-4"}']) {
    const response = await request(body);
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  assert.equal(calls, 3);
});

test('forwards request bytes and upstream credentials exactly and reports metering', async t => {
  const body = '{ "model": "publik-balanced", "messages": [{"role":"user","content":"héllo"}], "stream":false }';
  let received: { url?: string; method?: string; authorization?: string; contentType?: string; body: string } | undefined;
  const { gateway, request, events } = await fixture(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, method: req.method, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString() };
    res.writeHead(200, {
      'content-type': 'application/json', 'x-publik-balance': '123', 'x-publik-charge-micros': '5',
      'x-publik-week-used': '20', 'x-publik-week-budget': '100', 'x-publik-week-reset': 'tomorrow',
      'x-private-upstream': 'do-not-forward',
    });
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  const response = await request(body);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"choices":[{"message":{"content":"ok"}}]}');
  assert.deepEqual(received, { url: '/v1/chat/completions', method: 'POST', authorization: 'Bearer test-upstream-key', contentType: 'application/json', body });
  assert.notEqual(received?.authorization, `Bearer ${gateway.token}`);
  assert.equal(response.headers.get('x-publik-balance'), '123');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-private-upstream'), null);
  assert.deepEqual(events, [{ type: 'meter', balance: '123', charge: '5', usage: '20', budget: '100', reset: 'tomorrow' }]);
});

test('SSE bytes arrive incrementally and remain unchanged', { timeout: 5000 }, async t => {
  const first = ': keepalive\n\ndata: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const last = 'data: {"choices":[{"delta":{"content":" 世界"}}]}\n\ndata: [DONE]\n\n';
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const { request } = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await released;
    res.end(last);
  });
  const response = await request('{"model":"publik-fast","stream":true}');
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let initialSize = 0;
  while (initialSize < Buffer.byteLength(first)) {
    const initial = await reader.read();
    assert.equal(initial.done, false);
    chunks.push(Buffer.from(initial.value!));
    initialSize += initial.value!.byteLength;
  }
  assert.equal(Buffer.concat(chunks).toString(), first);
  release();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
  }
  assert.equal(Buffer.concat(chunks).toString(), first + last);
});

test('402 publishes a payment event and only returns a safe Publik top-up URL', async t => {
  let topUp = 'https://publikhq.com/billing?source=desktop';
  const { request, events } = await fixture(t, (_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Add balance', top_up_url: topUp } }));
  });
  for (const [candidate, expected] of [
    [topUp, topUp], ['https://publikhq.com.evil.invalid/billing', null], ['javascript:alert(1)', null],
  ] as const) {
    topUp = candidate;
    const response = await request('{"model":"publik-fast"}');
    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), { error: { message: 'Add balance', ...(expected ? { top_up_url: expected } : {}) } });
    assert.deepEqual(events.at(-1), { type: 'payment', message: 'Add balance', url: expected });
  }
});

test('malformed upstream payment payload has a safe fallback', async t => {
  let payload = 'not JSON';
  const { request, events } = await fixture(t, (_req, res) => { res.writeHead(402); res.end(payload); });
  for (const body of ['not JSON', 'null']) {
    payload = body;
    const response = await request('{"model":"publik-smart"}');
    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), { error: { message: 'Not enough API balance.' } });
    assert.deepEqual(events.at(-1), { type: 'payment', message: 'Not enough API balance.', url: null });
  }
});

test('own API mode permits vendor models without emitting Publik metering', async t => {
  const { request, events } = await fixture(t, (_req, res) => { res.end('{"ok":true}'); }, false);
  const response = await request('{"model":"vendor/my-model"}');
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(events, []);
});

test('upstream HTTP failures pass through while connection failures become sanitized 502s', async t => {
  let disconnect = false;
  const { request } = await fixture(t, (req, res) => {
    if (disconnect) { req.socket.destroy(); return; }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"temporarily unavailable"}}');
  });
  const failed = await request('{"model":"publik-fast"}');
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), '{"error":{"message":"temporarily unavailable"}}');
  disconnect = true;
  const disconnected = await request('{"model":"publik-fast"}');
  assert.equal(disconnected.status, 502);
  assert.deepEqual(await disconnected.json(), { error: { message: 'The model connection failed or was interrupted. Try again.' } });
});

test('requests at the body cap are rejected without reaching upstream', async t => {
  let calls = 0;
  const { request } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  const prefix = '{"model":"publik-fast","padding":"';
  const suffix = '"}';
  const body = prefix + 'x'.repeat(MAX_BODY - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(body), MAX_BODY);
  const response = await request(body);
  assert.equal(response.status, 413);
  assert.match((await response.json() as any).error.message, /under 4 MB/);
  assert.equal(calls, 0);
});

test('base URLs require HTTPS except for exact loopback hosts and exclude credentials/query/fragment', () => {
  assert.equal(validateBaseURL('https://api.example.com/v1///'), 'https://api.example.com/v1');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(validateBaseURL(`http://${host}:1234/v1`), `http://${host}:1234/v1`);
  }
  for (const url of ['http://example.com/v1', 'http://localhost.evil.invalid/v1', 'https://u:p@example.com/v1', 'https://example.com/v1?q=x', 'https://example.com/v1#x', 'file:///tmp/api', 'not a URL']) {
    assert.throws(() => validateBaseURL(url));
  }
});

test('safeLink blocks non-HTTPS, credentials, and lookalike hosts', () => {
  assert.equal(safeLink('https://publikhq.com/billing'), 'https://publikhq.com/billing');
  for (const url of [null, 42, 'bad', 'http://publikhq.com/billing', 'https://user:pass@publikhq.com/billing', 'https://publikhq.com.evil.invalid', 'https://evil.invalid/?next=publikhq.com']) {
    assert.equal(safeLink(url), null);
  }
  assert.equal(safeLink('https://own-provider.example/billing', false), 'https://own-provider.example/billing');
  assert.equal(safeLink('http://own-provider.example/billing', false), null);
});
