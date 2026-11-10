/** Render docs/media/cover.png (1200×630) from docs/media/src/cover.html and a real app screenshot.
 *  npx tsx scripts/render-cover.ts [docs/media/03-agent-editing.png] */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const shot = resolve(process.argv[2] ?? (existsSync('docs/media/03-agent-editing.png') ? 'docs/media/03-agent-editing.png' : 'docs/media/01-first-run.png'));
const html = readFileSync('docs/media/src/cover.html', 'utf8').replace('SHOT', `data:image/png;base64,${readFileSync(shot).toString('base64')}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'load' });
writeFileSync('docs/media/cover.png', await page.screenshot());
await browser.close();
console.log(`cover.png from ${shot}`);
