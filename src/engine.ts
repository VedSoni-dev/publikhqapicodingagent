// engine.ts — Publik Code's agent engine, built on Pi (@earendil-works/pi-coding-agent, MIT).
// Pi supplies the agent loop, built-in read/edit/write/bash tools, sessions and compaction.
// Publik Code adds: Publik as the default provider (through the local gateway, so no upstream key
// ever reaches Pi), an approval gate before any tool that changes files or runs commands, and an
// event stream for the desktop UI.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TIERS = ['publik-fast', 'publik-balanced', 'publik-smart'] as const;
export type Tier = (typeof TIERS)[number];
/** Tools that read only. Everything else (edit, write, bash, anything an extension adds) asks first. */
export const READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);
export const ENGINE_TOOLS = ['read', 'ls', 'find', 'grep', 'edit', 'write', 'bash'];

export type ApprovalRequest = { id: string; tool: string; input: unknown };
export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; tool: string; input: unknown }
  | { type: 'tool_end'; id: string; tool: string; output: string; isError: boolean }
  | { type: 'turn_end' }
  | { type: 'settled'; aborted: boolean }
  | { type: 'error'; message: string }
  | { type: 'compaction'; phase: 'start' | 'end' }
  | { type: 'retry'; attempt: number; maxAttempts: number; message: string };

export interface EngineOptions {
  cwd: string;
  /** Pi's agent dir. Kept inside the app's own data folder so a user's ~/.pi config never leaks in. */
  dataDir: string;
  /** The local gateway (127.0.0.1) and its per-launch bearer token. */
  gatewayURL: string;
  gatewayToken: string;
  provider: 'publik' | 'own';
  /** A Publik tier for provider 'publik', or the user's model id for 'own'. */
  model: string;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: EngineEvent) => void;
  /** 'continue' the most recent conversation for this folder (default), start a 'new' one, or keep it in 'memory' only (tests). */
  session?: 'continue' | 'new' | 'memory';
}

const SYSTEM_APPEND = 'You are running inside Publik Code, a desktop app. The user sees your text, each tool call, and approves every edit, write and shell command before it runs. If the user declines a tool call, do not retry the same call; ask what they would prefer.';

// Keep a real dynamic import in the CommonJS bundle: Pi is ESM-only.
const importESM = new Function('specifier', 'return import(specifier)') as <T = any>(specifier: string) => Promise<T>;

/** Pi's package is ESM-only ("import" export), so require.resolve can't find it: walk node_modules ourselves. */
function piEntry(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
    if (existsSync(join(pkgDir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      const rel = pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main ?? 'dist/index.js';
      return pathToFileURL(join(pkgDir, rel)).href;
    }
    if (dirname(dir) === dir) throw new Error('The Pi engine is missing from this build. Reinstall Publik Code.');
  }
}

function textOf(result: any): string {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text)).join('\n');
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text;
}

export function providerConfig(options: Pick<EngineOptions, 'gatewayURL' | 'gatewayToken' | 'provider' | 'model'>) {
  const model = (id: string, name: string) => ({
    type: 'chat' as const, id, name, reasoning: false, input: ['text'] as ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
  });
  return {
    name: options.provider === 'publik' ? 'Publik' : 'Your API',
    baseUrl: options.gatewayURL,
    apiKey: options.gatewayToken,
    api: 'openai-completions' as const,
    models: options.provider === 'publik'
      ? [model('publik-fast', 'Publik Fast'), model('publik-balanced', 'Publik Balanced'), model('publik-smart', 'Publik Smart')]
      : [model(options.model, options.model)],
  };
}

export async function startEngine(options: EngineOptions) {
  if (options.provider === 'publik' && !TIERS.includes(options.model as Tier)) throw new Error('Choose a Publik model tier.');
  // Resolve from this module's location so it works from source, the dist bundle and the packaged app.asar.
  const pi = await importESM<typeof import('@earendil-works/pi-coding-agent')>(piEntry());
  const agentDir = join(options.dataDir, 'pi');
  mkdirSync(agentDir, { recursive: true });
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const providerId = options.provider === 'publik' ? 'publik' : 'own';
  modelRuntime.registerProvider(providerId, providerConfig(options));
  const model = modelRuntime.getModel(providerId, options.model);
  if (!model) throw new Error('The selected model is not available.');

  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  let counter = 0;
  const gate = (api: any) => {
    api.on('tool_call', async (event: any) => {
      if (READ_ONLY_TOOLS.has(event.toolName)) return undefined;
      const ok = await options.approve({ id: event.toolCallId ?? `call-${++counter}`, tool: event.toolName, input: event.input });
      return ok ? undefined : { block: true, reason: 'The user declined this action.' };
    });
  };
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd, agentDir, settingsManager,
    // Project-supplied extensions/skills/prompts are executable or instruction-bearing; the desktop
    // app does not load them. AGENTS.md / CLAUDE.md context files still load, as in Pi.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: 'publik-code-approvals', factory: gate } as any],
    appendSystemPrompt: [SYSTEM_APPEND],
  });
  await resourceLoader.reload();
  const sessionDir = join(agentDir, 'sessions');
  const sessionManager = options.session === 'memory' ? pi.SessionManager.inMemory(options.cwd)
    : options.session === 'new' ? pi.SessionManager.create(options.cwd, sessionDir)
    : pi.SessionManager.continueRecent(options.cwd, sessionDir);
  const { session } = await pi.createAgentSession({
    cwd: options.cwd, agentDir, model, thinkingLevel: 'off', modelRuntime, resourceLoader,
    tools: ENGINE_TOOLS, sessionManager, settingsManager,
  });
  await session.bindExtensions?.({} as any);

  const unsubscribe = session.subscribe((event: any) => {
    const emit = options.onEvent;
    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e?.type === 'text_delta') emit({ type: 'text', delta: e.delta });
        else if (e?.type === 'thinking_delta') emit({ type: 'thinking', delta: e.delta });
        break;
      }
      case 'message_end':
        if (event.message?.role === 'assistant' && event.message?.stopReason === 'error') emit({ type: 'error', message: String(event.message.errorMessage ?? 'The model request failed.') });
        if (event.message?.role === 'assistant') emit({ type: 'turn_end' });
        break;
      case 'tool_execution_start': emit({ type: 'tool_start', id: event.toolCallId, tool: event.toolName, input: event.args }); break;
      case 'tool_execution_end': emit({ type: 'tool_end', id: event.toolCallId, tool: event.toolName, output: textOf(event.result), isError: Boolean(event.isError) }); break;
      case 'compaction_start': emit({ type: 'compaction', phase: 'start' }); break;
      case 'compaction_end': emit({ type: 'compaction', phase: 'end' }); break;
      case 'auto_retry_start': emit({ type: 'retry', attempt: event.attempt, maxAttempts: event.maxAttempts, message: String(event.errorMessage ?? '') }); break;
      case 'agent_settled': emit({ type: 'settled', aborted: Boolean(event.aborted) }); break;
    }
  });

  return {
    history: () => session.messages,
    prompt: async (text: string) => {
      if (session.isStreaming) return session.followUp(text);
      try { await session.prompt(text); }
      catch (error) { options.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) }); options.onEvent({ type: 'settled', aborted: false }); }
      return 'done';
    },
    abort: () => session.abort(),
    setTier: async (tier: Tier) => {
      const next = modelRuntime.getModel(providerId, tier);
      if (options.provider !== 'publik' || !next) throw new Error('Choose a Publik model tier.');
      await session.setModel(next);
    },
    stop: async () => { unsubscribe(); await session.abort().catch(() => {}); session.dispose(); },
  };
}
export type Engine = Awaited<ReturnType<typeof startEngine>>;
