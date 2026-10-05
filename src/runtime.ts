import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const TIERS = ['publik-fast', 'publik-balanced', 'publik-smart'] as const;
export function runtimeConfig(baseURL: string, token: string, tier: string, ownModel?: string) {
  if (!ownModel && !TIERS.includes(tier as any)) throw new Error('Invalid Publik tier.');
  const id = ownModel ? 'own' : 'publik';
  const models = ownModel ? [ownModel] : [...TIERS];
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `${id}/${ownModel ?? tier}`,
    small_model: `${id}/${ownModel ?? 'publik-fast'}`,
    enabled_providers: [id],
    share: 'disabled', autoupdate: false,
    permission: { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' },
    provider: { [id]: {
      npm: '@ai-sdk/openai-compatible', name: ownModel ? 'Your API' : 'Publik',
      options: { baseURL, apiKey: token },
      models: Object.fromEntries(models.map(model => [model, {
        name: model.replace('publik-', 'Publik '), tool_call: true,
        // Conservative defaults until Publik publishes tier context/output limits.
        limit: { context: 32768, output: 8192 },
      }])),
    } },
  };
}
export function childEnvironment(dataDir: string, config: unknown, password: string): Record<string, string> {
  // Preserve developer tool paths, but never inherit model credentials or parent OpenCode settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(OPENCODE_|PUBLIK_|OPENAI_|ANTHROPIC_|GOOGLE_API_KEY$|GEMINI_API_KEY$|AWS_|AZURE_OPENAI_|OPENROUTER_|ELECTRON_RUN_AS_NODE$)/i.test(k))) as Record<string, string>;
  return { ...env, XDG_CONFIG_HOME: join(dataDir, 'config'), XDG_DATA_HOME: join(dataDir, 'data'), XDG_CACHE_HOME: join(dataDir, 'cache'), XDG_STATE_HOME: join(dataDir, 'state'), OPENCODE_TEST_HOME: join(dataDir, 'home'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'publik-code', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' };
}
export async function startRuntime(options: { binary: string; cwd: string; dataDir: string; config: unknown; onExit?: () => void }) {
  await mkdir(join(options.dataDir, 'home'), { recursive: true });
  const password = randomBytes(32).toString('hex');
  const child = spawn(options.binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: options.cwd, env: childEnvironment(options.dataDir, options.config, password),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let intentional = false;
  child.once('exit', () => { if (!intentional) options.onExit?.(); });
  const stop = async () => {
    intentional = true;
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', () => resolve()); killer.once('exit', () => resolve()); });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('The coding engine did not start within 60 seconds.')), 60000);
      const fail = () => { clearTimeout(timer); reject(new Error('The coding engine could not start. Check the platform build and available disk space.')); };
      child.once('error', fail); child.once('exit', fail);
      child.stderr?.on('data', () => {}); // Never forward runtime logs: they may contain model payloads.
      child.stdout?.on('data', chunk => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail); resolve(match[1]); }
      });
    });
    const auth = `Basic ${Buffer.from(`publik-code:${password}`).toString('base64')}`;
    const response = await fetch(`${url}/global/health`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('The coding engine failed its startup check.');
    return { url, password, auth, stop };
  } catch (error) { await stop(); throw error; }
}
