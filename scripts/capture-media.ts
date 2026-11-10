/** Capture listing media from the real app.
 *
 *   npx tsx scripts/capture-media.ts            # onboarding, Publik linking and settings shots (no model calls)
 *   MEDIA_LIVE=1 npx tsx scripts/capture-media.ts  # + live publik-balanced task: editing, diff approval, video
 *
 * Live mode uses this computer's real Publik credential and spends real (small) balance.
 * It never uses a mock model. The demo project is a small sample created in a temp folder
 * and labeled as sample in the captions. Output: docs/media/*.png, artifacts/demo-video/*.webm
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIVE = process.env.MEDIA_LIVE === '1';
const out = resolve('docs/media');
await mkdir(out, { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'publik-media-')));
const W = 1280, H = 820;

function baseEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  for (const k of ['ELECTRON_RUN_AS_NODE', 'PUBLIK_API_KEY', 'PUBLIK_APP_TOKEN']) delete env[k];
  return { ...env, ...extra };
}
async function open(env: Record<string, string>, profile: string, video?: string) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, profile)}`], env, ...(video ? { recordVideo: { dir: video, size: { width: W, height: H } } } : {}) });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(out, name) });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

let app: ElectronApplication | undefined;
try {
  // 1) First run on a fresh computer: no Publik credential, no saved key.
  const fresh = join(root, 'home');
  ({ app } = await open(baseEnv({ HOME: fresh, XDG_CONFIG_HOME: join(fresh, '.config') }), 'fresh'));
  let page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Make something worth shipping.' })).toBeVisible();
  await pause(400);
  await shot(page, '01-first-run.png');
  // 5) Settings: bring your own key (OpenAI-compatible endpoint). Nothing is saved.
  await page.getByRole('button', { name: 'Your own API key' }).click();
  await page.getByLabel('Model ID', { exact: true }).fill('your-model-id');
  await pause(300);
  await shot(page, '05-settings-own-key.png');
  await app.close(); app = undefined;

  // 2) Publik linked/provisioned: this computer's real credential, balance from GET /wallet.
  const workspace = join(root, 'sample-todo-app');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Sample: todo-app\n\nA tiny sample project used for the Publik Code demo.\n');
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'sample-todo-app', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeFile(join(workspace, 'src', 'todos.js'), [
    'export function addTodo(list, title) {',
    '  list.push({ title, done: false });',
    '  return list;',
    '}',
    '',
    'export function completeTodo(list, index) {',
    '  list[index].done = true;',
    '  return list;',
    '}',
    '',
  ].join('\n'));
  const video = LIVE ? join(resolve('artifacts'), 'demo-video') : undefined;
  if (video) { await rm(video, { recursive: true, force: true }); await mkdir(video, { recursive: true }); }
  ({ app } = await open(baseEnv({ PUBLIK_CODE_TEST: '1', PUBLIK_CODE_TEST_WORKSPACE: workspace }), 'publik', video));
  page = await app.firstWindow();
  await expect(page.getByText('Publik connected')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
  await pause(1500);
  await shot(page, '02-publik-linking.png');

  if (LIVE) {
    // 3/4) A live publik-balanced task on the sample project.
    await page.getByRole('button', { name: 'Choose a project folder' }).click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 30000 });
    await pause(800);
    await page.getByLabel('Message').pressSequentially('Add a removeTodo(list, index) function to src/todos.js, matching the existing style.', { delay: 18 });
    await pause(500);
    await page.getByRole('button', { name: 'Send' }).click();
    for (let i = 0; i < 6; i++) {
      const ask = page.locator('.tool.asking');
      const done = page.locator('#abort[hidden]');
      await Promise.race([ask.first().waitFor({ timeout: 120000 }), done.waitFor({ state: 'attached', timeout: 120000 })]);
      if (await ask.count() === 0) break;
      await ask.first().scrollIntoViewIfNeeded();
      await pause(1200);
      if (i === 0) await shot(page, '04-diff-approval.png');
      await page.getByRole('button', { name: 'Allow', exact: true }).first().click();
    }
    await page.locator('#abort[hidden]').waitFor({ state: 'attached', timeout: 180000 });
    await pause(1500);
    await shot(page, '03-agent-editing.png');
  }
  await app.close(); app = undefined;
  console.log(`Captured media in ${out}${LIVE ? ` and video in ${video}` : ' (no live shots; set MEDIA_LIVE=1)'}`);
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
