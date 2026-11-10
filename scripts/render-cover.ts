/** Render docs/media/cover.png (1200×630) from docs/media/src/cover.html and a real app screenshot.
 *  npx tsx scripts/render-cover.ts [docs/media/03-agent-editing.png]   (uses the project's Electron) */
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const shot = resolve(process.argv[2] ?? (existsSync('docs/media/03-agent-editing.png') ? 'docs/media/03-agent-editing.png' : 'docs/media/01-first-run.png'));
const dir = mkdtempSync(join(tmpdir(), 'publik-cover-'));
writeFileSync(join(dir, 'cover.html'), readFileSync('docs/media/src/cover.html', 'utf8').replace('SHOT', `data:image/png;base64,${readFileSync(shot).toString('base64')}`));
writeFileSync(join(dir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1200, height: 630, show: false, useContentSize: true, webPreferences: { offscreen: false } });
  await w.loadFile(${JSON.stringify(join(dir, 'cover.html'))});
  await new Promise(r => setTimeout(r, 500));
  require('fs').writeFileSync(${JSON.stringify(resolve('docs/media/cover.png'))}, (await w.webContents.capturePage()).toPNG());
  app.quit();
});`);
const app = await electron.launch({ args: [join(dir, 'main.cjs')] });
await new Promise<void>(r => app.process().on('exit', () => r()));
rmSync(dir, { recursive: true, force: true });
console.log(`cover.png from ${shot}`);
