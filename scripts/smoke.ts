import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGateway } from '../src/gateway';
import { runtimeConfig, startRuntime } from '../src/runtime';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'publik-code-smoke-')));
await writeFile(join(temp, 'hello.txt'), 'Hello from the workspace\n');
let calls = 0;
let toolObserved = false;
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.model, 'publik-fast');
  assert.equal(req.headers.authorization, 'Bearer test-upstream-key');
  calls++;
  const tools = body.tools ?? [];
  const tool = tools.find((t: any) => t.function?.name === 'read');
  const hasResult = body.messages.some((message: any) => message.role === 'tool');
  if (hasResult) toolObserved = true;
  let delta;
  let reason;
  if (!hasResult && tool && calls < 3) {
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(temp, 'hello.txt') }) } }] };
    reason = 'tool_calls';
  } else { delta = { role: 'assistant', content: 'The file says: Hello from the workspace.' }; reason = 'stop'; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-publik-balance': '$1.00', 'x-publik-charge-micros': '5' });
  const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  chunk({ id: `mock-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ id: `mock-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address() as any;
let gateway;
let engine;
try {
  gateway = await startGateway({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-upstream-key', publik: true });
  engine = await startRuntime({ binary: resolve('build/runtime', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), cwd: temp, dataDir: join(temp, 'engine'), config: runtimeConfig(gateway.baseURL, gateway.token, 'publik-fast') });
  const request = async (path: string, method = 'GET', body?: any) => {
    console.log(`Checking ${method} ${path.replace(/ses_[^/]+/, '<session>')}`);
    const response = await fetch(engine!.url + path, { method, headers: { authorization: engine!.auth, 'content-type': 'application/json', 'x-opencode-directory': temp }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data).slice(0,1000)}`);
    return data as any;
  };
  const health = await request('/global/health');
  assert.equal(health.healthy, true);
  assert.equal((await fetch(engine.url + '/global/health')).status, 401);
  const config = await request('/config');
  assert.equal(config.model, 'publik/publik-fast');
  assert.equal(config.permission.edit ?? config.permission['*'], 'ask');
  const htmlResponse = await fetch(engine.url, { headers: { authorization: engine.auth }, signal: AbortSignal.timeout(15000) });
  assert.ok(htmlResponse.headers.get('content-type')?.includes('text/html'));
  assert.match(await htmlResponse.text(), /<html/i);
  const session = await request('/session', 'POST', { title: 'Publik adapter smoke test' });
  const result = await request(`/session/${session.id}/message`, 'POST', { model: { providerID: 'publik', modelID: 'publik-fast' }, parts: [{ type: 'text', text: 'Read hello.txt and tell me what it contains.' }] });
  assert.ok(!result.info?.error, JSON.stringify(result.info?.error));
  assert.ok(toolObserved, 'Expected a real local read-tool result sent back to the mock provider');
  assert.ok(result.parts.some((p: any) => p.type === 'text' && p.text.includes('Hello from the workspace')));
  console.log(`PASS: real OpenCode startup, authenticated UI/API, provider config, SSE, local read tool, result round-trip (${calls} mock calls). No paid API used.`);
} finally {
  await engine?.stop(); await gateway?.close();
  upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
