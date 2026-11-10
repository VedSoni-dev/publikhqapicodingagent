import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main.cjs', external: ['electron'], target: 'node22', define: { 'import.meta.url': '__publikModuleUrl' }, banner: { js: 'const __publikModuleUrl = require("node:url").pathToFileURL(__filename).href;' } });
await build({ entryPoints: ['src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload.cjs', external: ['electron'], target: 'node22' });
console.log('Built Publik Code (engine: Pi via @earendil-works/pi-coding-agent).');
