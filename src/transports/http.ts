import {AsyncLocalStorage} from 'node:async_hooks';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {digest} from '../auth/hash.js';
import {TokenBroker} from '../auth/token-cache.js';
import {credentialsFrom, type Env, API_BASES} from '../config.js';
import {bucketKey, buildHops, formatIp, parseIp, resolveClientIp, type Hops} from '../http/client-address.js';
import {WindowLimiter} from '../http/limits.js';
import {createServer} from '../server.js';
import type {Docs} from '../tools/docs.js';

/**
 * Hosted transport: stateless Streamable HTTP on POST /mcp, GET /healthz.
 *
 * - The environment is fixed when the process starts (one deployment per
 *   host, D-14); nothing in a request can change it.
 * - Keys arrive in X-OnePlatform-App-Key / X-OnePlatform-User-Key on every request,
 *   live only in memory for that request and in the digest-keyed caches; they
 *   are never logged.
 * - Limits run before anything is exchanged: 30/min per client IP, 120/min per
 *   key pair, a 256 KiB body. Over the limit answers 429 with a JSON-RPC error.
 * - The client IP is resolved behind Cloudflare and the front door with the
 *   port of the Core's resolver (`client-address.ts`, D-12): our hops are the
 *   private ranges plus MCP_TRUSTED_PROXY_CIDRS, and exactly one Cloudflare
 *   edge is skipped. It keys the per-IP limit (IPv6 by /64).
 * - Every call to the API carries `X-Forwarded-For: <that client>` written
 *   FRESH, one entry, never the header the client sent. The API trusts this
 *   container as a private hop, so its own per-IP limits (the 10/min token
 *   exchange) count one bucket per client — measured on the host 2026-10-31.
 * - `apiBase` overrides the public API URL with the internal one of the
 *   deployment (same host, Docker network); it comes from the process
 *   environment, never from a request.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export interface HttpOptions {
  env: Env;
  fetch: typeof fetch;
  docs: Docs;
  broker?: TokenBroker;
  /** Overrides the public API URL for `env` (hosted: the internal address). */
  apiBase?: string;
  /** Our hops for the client-IP walk; defaults to the private ranges only. */
  hops?: Hops;
  /** Test seam: the client's address as text. Defaults to the D-12 walk. */
  clientIp?: (req: IncomingMessage) => string;
  perIp?: WindowLimiter;
  perKeys?: WindowLimiter;
  log?: (line: Record<string, unknown>) => void;
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify({jsonrpc: '2.0', error: {code, message}, id: null}));
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Adds the request's client as the ONLY X-Forwarded-For entry on calls to `apiBase`. */
export function forwardingFetch(base: typeof fetch, apiBase: string, current: () => string | undefined): typeof fetch {
  const origin = new URL(apiBase).origin;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const client = current();
    if (!client || new URL(url).origin !== origin) return base(input, init);
    const headers = new Headers(init?.headers);
    headers.set('x-forwarded-for', client);
    return base(input, {...init, headers});
  }) as typeof fetch;
}

export function createHttpHandler(options: HttpOptions) {
  const apiBase = options.apiBase ?? API_BASES[options.env];
  const store = new AsyncLocalStorage<string>();
  const upstream = forwardingFetch(options.fetch, apiBase, () => store.getStore());
  const broker = options.broker ?? new TokenBroker({apiBase, fetch: upstream});
  const perIp = options.perIp ?? new WindowLimiter(30);
  const perKeys = options.perKeys ?? new WindowLimiter(120);
  const hops = options.hops ?? buildHops([]);
  const clientIp = options.clientIp ?? ((req: IncomingMessage) => {
    const ip = resolveClientIp(req.socket.remoteAddress, header(req, 'x-forwarded-for'), hops);
    return ip ? formatIp(ip) : 'unknown';
  });
  const limitKey = (ip: string) => {
    const parsed = parseIp(ip);
    return parsed ? bucketKey(parsed) : ip;
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mcp.local');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({status: 'ok', env: options.env}));
      return;
    }
    if (url.pathname !== '/mcp') return rpcError(res, 404, -32601, 'Not found');
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return rpcError(res, 405, -32000, 'Method not allowed');
    }
    const client = clientIp(req);
    if (!perIp.allow(limitKey(client))) return rpcError(res, 429, -32029, 'Too many requests');
    const credentials = credentialsFrom(header(req, 'x-oneplatform-app-key'), header(req, 'x-oneplatform-user-key'));
    if (credentials && !perKeys.allow(digest(credentials.appKey, credentials.userKey))) return rpcError(res, 429, -32029, 'Too many requests');
    const raw = await readBody(req);
    if (raw === undefined) return rpcError(res, 413, -32600, 'Request body too large');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return rpcError(res, 400, -32700, 'Parse error');
    }
    const server = createServer({credentials, apiBase, fetch: upstream, broker, docs: options.docs, log: options.log});
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await store.run(client === 'unknown' ? '' : client, () => transport.handleRequest(req, res, body));
  };
}
