import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

import {TokenBroker} from '../src/auth/token-cache.js';
import type {Credentials} from '../src/config.js';
import {createServer} from '../src/server.js';
import {Docs} from '../src/tools/docs.js';

export const QA = 'https://api-qa.1platform.pro/api/v1';
export const DOCS = 'https://developer.1platform.pro';

export type Call = {url: string; method: string; headers: Record<string, string>; body?: string};
export type Responder = (call: Call) => {status: number; body: unknown} | Promise<{status: number; body: unknown}>;

/** A fake API that records every request. Token exchanges answer by default. */
export function fakeApi(responder: Responder = () => ({status: 200, body: {success: true, data: {}, msg: 'ok'}})) {
  const calls: Call[] = [];
  let n = 0;
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body as string | undefined};
    calls.push(call);
    if (call.url.endsWith('/auth/token') || call.url.endsWith('/users/token')) {
      const custom = await responder(call);
      if (custom.status !== 200 || (custom.body as {data?: {access_token?: string}})?.data?.access_token) {
        return new Response(typeof custom.body === 'string' ? custom.body : JSON.stringify(custom.body), {status: custom.status});
      }
      n += 1;
      return new Response(JSON.stringify({success: true, data: {access_token: `jwt-${call.url.endsWith('/auth/token') ? 'app' : 'user'}-${n}`, expires_in: 1800}, msg: 'ok'}), {status: 200});
    }
    const out = await responder(call);
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {status: out.status});
  }) as typeof fetch;
  const count = (suffix: string) => calls.filter((c) => c.url.split('?')[0]!.endsWith(suffix)).length;
  return {fetch: impl, calls, count};
}

export async function connect(options: {credentials?: Credentials; fetch: typeof fetch; broker?: TokenBroker; log?: (l: Record<string, unknown>) => void}) {
  const broker = options.broker ?? new TokenBroker({apiBase: QA, fetch: options.fetch});
  const docs = new Docs({docsBase: DOCS, fetch: options.fetch});
  const server = createServer({credentials: options.credentials, apiBase: QA, fetch: options.fetch, broker, docs, log: options.log});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '0.0.0'});
  await Promise.all([server.connect(a), client.connect(b)]);
  return {client, broker};
}

export const KEYS: Credentials = {appKey: 'ak-test-app', userKey: 'sk-test-user'};
