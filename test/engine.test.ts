import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startGateway } from '../src/gateway.js';
import { providerConfig, startEngine, type ApprovalRequest, type EngineEvent } from '../src/engine.js';

// A scripted OpenAI-compatible upstream: each request gets the next streamed reply.
function sse(res: any, chunks: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-publik-balance': '49000', 'x-publik-charge-micros': '1000' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const base = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'publik-balanced' };
const toolCall = (id: string, name: string, args: unknown) => [
  { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];
const text = (t: string) => [
  { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];

test('Publik provider config exposes only tier models through the local gateway', () => {
  const c = providerConfig({ gatewayURL: 'http://127.0.0.1:1/v1', gatewayToken: 't', provider: 'publik', model: 'publik-balanced' });
  assert.deepEqual(c.models.map(m => m.id), ['publik-fast', 'publik-balanced', 'publik-smart']);
  assert.equal(c.api, 'openai-completions');
  assert.equal(c.baseUrl, 'http://127.0.0.1:1/v1');
});

test('Pi engine reads freely, asks before writing, and honors a decline', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'publik-engine-')));
  const work = join(dir, 'work');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(work);
  writeFileSync(join(work, 'notes.txt'), 'hello from the repo\n');
  const replies = [
    toolCall('c1', 'read', { path: 'notes.txt' }),
    toolCall('c2', 'write', { path: 'evil.txt', content: 'nope' }),
    text('Done: the file says hello.'),
  ];
  const seen: any[] = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push(JSON.parse(body));
    sse(res, replies.shift() ?? text('extra'));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as any).port;
  const meters: unknown[] = [];
  const gateway = await startGateway({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'upstream-key', publik: true, onEvent: e => meters.push(e) });
  const approvals: ApprovalRequest[] = [];
  const events: EngineEvent[] = [];
  t.after(async () => { await gateway.close(); upstream.closeAllConnections(); upstream.close(); rmSync(dir, { recursive: true, force: true }); });
  const engine = await startEngine({
    cwd: work, dataDir: join(dir, 'data'), gatewayURL: gateway.baseURL, gatewayToken: gateway.token,
    provider: 'publik', model: 'publik-balanced', session: 'memory',
    approve: async r => { approvals.push(r); return false; }, onEvent: e => events.push(e),
  });
  t.after(() => engine.stop());

  await engine.prompt('What does notes.txt say?');

  assert.equal(seen.length, 3);
  assert.ok(seen.every(r => r.model === 'publik-balanced' && r.stream === true));
  assert.deepEqual(approvals.map(a => a.tool), ['write']);
  assert.equal(existsSync(join(work, 'evil.txt')), false);
  const read = events.find(e => e.type === 'tool_end' && e.tool === 'read') as any;
  assert.match(read.output, /hello from the repo/);
  const write = events.find(e => e.type === 'tool_end' && e.tool === 'write') as any;
  assert.equal(write.isError, true);
  assert.equal(events.filter(e => e.type === 'text').map((e: any) => e.delta).join(''), 'Done: the file says hello.');
  assert.ok(meters.some((m: any) => m.type === 'meter' && m.balance === '49000'));
  assert.ok(!JSON.stringify(seen).includes('upstream-key'));
  assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'hello from the repo\n');
});
