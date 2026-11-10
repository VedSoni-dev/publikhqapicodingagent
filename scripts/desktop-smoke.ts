/** Electron end-to-end smoke with a scripted local model (no paid calls): onboarding, own-key
 *  connection, Pi workspace, an approved edit that lands on disk, a declined command, shutdown. */
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'publik-code-desktop-')));
const workspace = join(temp, 'project');
await mkdir(workspace);
await writeFile(join(workspace, 'greet.js'), "export const greet = name => 'Hi ' + name;\n");

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 0, model: 'local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (id: string, name: string, args: unknown) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, 'tool_calls');
const say = (text: string) => chunk({ role: 'assistant', content: text }) + chunk({}, 'stop');
const script = [
  call('c1', 'read', { path: 'greet.js' }),
  call('c2', 'edit', { path: 'greet.js', edits: [{ oldText: "'Hi ' + name", newText: '`Hello, ${name}!`' }] }),
  call('c3', 'bash', { command: 'rm -rf ./node_modules' }),
  say('Updated greet.js to use a template literal. I skipped the cleanup command.'),
];
let calls = 0;
const upstream = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  calls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end((script.shift() ?? say('ok')) + 'data: [DONE]\n\n');
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
const port = (upstream.address() as any).port;

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
for (const k of ['ELECTRON_RUN_AS_NODE', 'PUBLIK_API_KEY', 'PUBLIK_APP_TOKEN']) delete env[k];
// Isolate from any real Publik credential file on this machine (it lives under $HOME).
env.HOME = temp; env.XDG_CONFIG_HOME = join(temp, '.config'); env.LOCALAPPDATA = join(temp, 'AppData');
env.PUBLIK_CODE_TEST = '1';
env.PUBLIK_CODE_TEST_WORKSPACE = workspace;
const executablePath = process.env.PUBLIK_CODE_PACKAGED_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Make something worth shipping.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a project folder' })).toBeDisabled();
  await page.getByRole('button', { name: 'Your own API key' }).click();
  await page.getByLabel('API base URL').fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel('API key', { exact: true }).fill('test-only-not-a-real-key');
  await page.getByLabel('Model ID', { exact: true }).fill('local-model');
  await page.getByLabel('Remember securely on this computer').uncheck();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('Your API connected')).toBeVisible();
  const exposed = await page.evaluate(async () => JSON.stringify(await (window as any).publik.state()));
  if (exposed.includes('test-only-not-a-real-key')) throw new Error('A saved key leaked into renderer state');
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.locator('#workspace')).toBeVisible({ timeout: 30000 });
  await page.getByLabel('Message').fill('Make greet friendlier.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Apply this edit?')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Run this command?')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.getByText('I skipped the cleanup command.')).toBeVisible({ timeout: 30000 });
  const after = await readFile(join(workspace, 'greet.js'), 'utf8');
  if (!after.includes('`Hello, ${name}!`')) throw new Error(`Approved edit did not land: ${after}`);
  if (calls !== 4) throw new Error(`Expected 4 model calls, saw ${calls}`);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/desktop-workspace.png') });
  await page.getByRole('button', { name: 'Close project' }).click();
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#running-actions')).toBeHidden();
  await page.getByRole('button', { name: 'Publik balance', exact: true }).click();
  await page.getByRole('button', { name: 'Use Publik instead' }).click();
  await expect(page.getByText('Get started', { exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 850));
  await page.screenshot({ path: resolve('artifacts/desktop-narrow.png'), fullPage: true });
  console.log('PASS: onboarding, own-key connect, Pi workspace, approved edit applied, declined command blocked, close, provider switch, key redaction.');
} finally {
  await app.close();
  upstream.closeAllConnections(); upstream.close();
  await rm(temp, { recursive: true, force: true });
}
