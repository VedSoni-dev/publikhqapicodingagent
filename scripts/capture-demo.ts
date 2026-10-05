/** Capture an honest, reproducible local mock-provider demo. No paid APIs or personal projects. */
import { _electron as electron, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = await realpath(await mkdtemp(join(tmpdir(), 'publik-showcase-')));
const workspace = join(root, 'hello-publik');
await mkdir(workspace);
await writeFile(join(workspace, 'README.md'), '# Hello, Publik\n\nA tiny project for a focused coding session.\n\n- Work in your local folder\n- Choose your model provider\n- Review tool activity\n');
let calls = 0;
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls++;
  const hasResult = body.messages?.some((m: any) => m.role === 'tool');
  const read = body.tools?.find((t: any) => t.function?.name === 'read');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `demo-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (read && !hasResult) {
    emit({ role: 'assistant', content: 'I’ll read the project README first.' });
    emit({ tool_calls: [{ index: 0, id: `read-${calls}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(workspace, 'README.md') }) } }] });
    emit({}, 'tool_calls');
  } else {
    const answer = !body.tools?.length && !hasResult ? 'Hello, Publik' : 'This project is **Hello, Publik** — a small starting point for a focused coding session.\n\n- **Local workspace:** your files stay in the project folder.\n- **Model choice:** connect the API you want to use.\n- **Visible tools:** review what the agent reads and runs.\n\nI read `README.md`. No files were changed.';
    for (const piece of answer.match(/.{1,18}|\n/g) ?? []) { emit({ content: piece }); await new Promise(r => setTimeout(r, 35)); }
    emit({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
const port = (upstream.address() as any).port;
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => e[1] !== undefined && !['ELECTRON_RUN_AS_NODE','PUBLIK_API_KEY','PUBLIK_APP_TOKEN'].includes(e[0])));
env.PUBLIK_CODE_TEST='1';env.PUBLIK_CODE_TEST_WORKSPACE=workspace;
const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], env });
const frames = resolve('artifacts/demo-frames');
await rm(frames,{recursive:true,force:true});await mkdir(frames,{recursive:true});await mkdir('docs/media',{recursive:true});
let contentPage: Page | undefined;
let recording = false;
let count = 0;
let recorder: Promise<void> | undefined;
const capture = async (name?: string) => {
  const target = name ? resolve('docs/media',name) : join(frames,`${String(count++).padStart(4,'0')}.png`);
  if (contentPage) { await contentPage.screenshot({ path: target }); return; }
  const encoded=await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await writeFile(target,Buffer.from(encoded,'base64'));
};
try {
  const page=await app.firstWindow();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1240,840));
  await page.getByRole('button',{name:'Your own API key'}).click();
  await page.getByLabel('API base URL').fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel('API key',{exact:true}).fill('local-demo-only');
  await page.getByLabel('Model ID',{exact:true}).fill('demo-coder');
  await page.getByLabel('Remember securely on this computer').uncheck();
  await page.getByRole('button',{name:'Save connection'}).click();
  await expect(page.getByText('Your API connected')).toBeVisible();
  await capture('connection.png');
  await page.getByRole('button',{name:'Choose a project folder'}).click();
  await expect(page.locator('#home')).toBeHidden({timeout:70000});
  const enginePage = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
  if(!enginePage) throw new Error('No engine page');
  await enginePage.waitForLoadState('domcontentloaded');
  contentPage = enginePage;
  const input=enginePage.locator('[contenteditable="true"]').first();
  await input.waitFor({state:'visible',timeout:30000});
  await capture('workspace.png');
  await input.fill('Read README.md and give me a quick tour of this project.');
  recording=true;
  recorder=(async()=>{while(recording){await capture();await new Promise(r=>setTimeout(r,200));}})();
  await new Promise(r=>setTimeout(r,1200));
  await input.press('Enter');
  await expect(enginePage.getByText('No files were changed.',{exact:false})).toBeVisible({timeout:60000});
  await new Promise(r=>setTimeout(r,2000));
  recording=false;await recorder;
  await capture('coding-session.png');
  console.log(`Captured ${count} frames, ${calls} local mock calls. Demo files are isolated and no real model was used.`);
} finally {
  recording=false;await recorder?.catch(()=>{});await app.close();
  upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));
  await rm(root,{recursive:true,force:true});
}
