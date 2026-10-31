import type {IncomingMessage, ServerResponse} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {digest} from '../auth/hash.js';
import {TokenBroker} from '../auth/token-cache.js';
import {credentialsFrom, type Env, API_BASES} from '../config.js';
import {WindowLimiter} from '../http/limits.js';
import {createServer} from '../server.js';
import type {Docs} from '../tools/docs.js';

/**
 * Hosted transport: stateless Streamable HTTP on POST /mcp, GET /healthz.
 *
 * - The environment is fixed when the process starts (one deployment per
 *   host, D-14); nothing in a request can change it.
 * - Keys arrive in X-1Platform-App-Key / X-1Platform-User-Key on every request,
 *   live only in memory for that request and in the digest-keyed caches; they
 *   are never logged.
 * - Limits run before anything is exchanged: 30/min per client IP, 120/min per
 *   key pair, a 256 KiB body. Over the limit answers 429 with a JSON-RPC error.
 * - The client IP comes from `clientIp`. Until the hosted deployment's proxy
 *   chain is measured (F6, D-12) it is the socket peer, and the server does NOT
 *   write X-Forwarded-For upstream.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export interface HttpOptions {
  env: Env;
  fetch: typeof fetch;
  docs: Docs;
  broker?: TokenBroker;
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

export function createHttpHandler(options: HttpOptions) {
  const apiBase = API_BASES[options.env];
  const broker = options.broker ?? new TokenBroker({apiBase, fetch: options.fetch});
  const perIp = options.perIp ?? new WindowLimiter(30);
  const perKeys = options.perKeys ?? new WindowLimiter(120);
  const clientIp = options.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');

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
    if (!perIp.allow(clientIp(req))) return rpcError(res, 429, -32029, 'Too many requests');
    const credentials = credentialsFrom(header(req, 'x-1platform-app-key'), header(req, 'x-1platform-user-key'));
    if (credentials && !perKeys.allow(digest(credentials.appKey, credentials.userKey))) return rpcError(res, 429, -32029, 'Too many requests');
    const raw = await readBody(req);
    if (raw === undefined) return rpcError(res, 413, -32600, 'Request body too large');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return rpcError(res, 400, -32700, 'Parse error');
    }
    const server = createServer({credentials, apiBase, fetch: options.fetch, broker, docs: options.docs, log: options.log});
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
