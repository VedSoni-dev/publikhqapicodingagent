import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_BODY = 4 * 1024 * 1024;
export function safeLink(value: unknown, publikOnly = true): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!publikOnly || u.hostname === 'publikhq.com') ? u.href : null;
  } catch { return null; }
}
export function validateBaseURL(value: string): string {
  const u = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) {
    throw new Error('Use an HTTPS API base URL, or HTTP on localhost.');
  }
  return u.href.replace(/\/+$/, '');
}
export type GatewayEvent = { type: 'meter'; balance: string | null; charge: string | null; usage: string | null; budget: string | null; reset: string | null } | { type: 'payment'; message: string; url: string | null };
export async function startGateway(options: {
  baseURL: string; apiKey: string; publik: boolean; onEvent?: (event: GatewayEvent) => void;
}) {
  const baseURL = validateBaseURL(options.baseURL);
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const provided = Buffer.from(req.headers.authorization ?? '');
    const json = (status: number, body: unknown) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: { message: 'Unauthorized' } });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { message: 'Not found' } });
    const abort = new AbortController();
    controllers.add(abort);
    const timeout = setTimeout(() => abort.abort(), 15 * 60 * 1000);
    req.on('aborted', () => abort.abort());
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size >= MAX_BODY) { json(413, { error: { message: 'Keep requests under 4 MB. Reduce context or resize images.' } }); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let parsed: any;
      try { parsed = JSON.parse(body.toString()); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { return json(400, { error: { message: 'Invalid JSON' } }); }
      if (options.publik && !['publik-fast', 'publik-balanced', 'publik-smart'].includes(parsed.model)) {
        return json(400, { error: { message: 'Choose a Publik model tier.' } });
      }
      const upstream = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body, signal: abort.signal, redirect: 'error',
      });
      if (options.publik) {
        options.onEvent?.({ type: 'meter', balance: upstream.headers.get('x-publik-balance'), charge: upstream.headers.get('x-publik-charge-micros'), usage: upstream.headers.get('x-publik-week-used'), budget: upstream.headers.get('x-publik-week-budget'), reset: upstream.headers.get('x-publik-week-reset') });
      }
      if (upstream.status === 402) {
        const data = (await upstream.json().catch(() => ({})) ?? {}) as any;
        const message = typeof data.error?.message === 'string' ? data.error.message : 'Not enough API balance.';
        const url = safeLink(data.error?.top_up_url, options.publik);
        options.onEvent?.({ type: 'payment', message, url });
        return json(402, { error: { message, ...(url ? { top_up_url: url } : {}) } });
      }
      const headers: Record<string, string> = { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' };
      upstream.headers.forEach((value, key) => { if (key.startsWith('x-publik-')) headers[key] = value; });
      res.writeHead(upstream.status, headers);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), res);
      else res.end();
    } catch {
      if (!res.headersSent) json(502, { error: { message: 'The model connection failed or was interrupted. Try again.' } });
      else res.destroy();
    } finally { clearTimeout(timeout); controllers.delete(abort); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start local model gateway.');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`, token,
    close: async () => {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
