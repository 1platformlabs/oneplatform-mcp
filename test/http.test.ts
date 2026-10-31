import type {AddressInfo} from 'node:net';
import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';

import {WindowLimiter} from '../src/http/limits.js';
import {Docs} from '../src/tools/docs.js';
import {createHttpHandler, MAX_BODY_BYTES} from '../src/transports/http.js';
import {DOCS, fakeApi} from './helpers.js';

const open: Array<() => Promise<void>> = [];
afterEach(async () => { while (open.length) await open.pop()!(); });

async function start(options: {ip?: () => string; perIp?: WindowLimiter; perKeys?: WindowLimiter} = {}) {
  const api = fakeApi();
  const handler = createHttpHandler({env: 'qa', fetch: api.fetch, docs: new Docs({docsBase: DOCS, fetch: api.fetch}), clientIp: options.ip, perIp: options.perIp, perKeys: options.perKeys});
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});
  return {base, api, rpc};
}

const list = {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}};

describe('IPA-05 hosted transport', () => {
  it('GET /healthz is 200 and names the fixed environment', async () => {
    const {base} = await start();
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({status: 'ok', env: 'qa'});
  });
  it('tools/list over Streamable HTTP; keys in headers add the API tools', async () => {
    const {rpc} = await start();
    const anon = await (await rpc(list)).json();
    expect(anon.result.tools).toHaveLength(3);
    const keyed = await (await rpc(list, {'x-1platform-app-key': 'ak-a', 'x-1platform-user-key': 'sk-a'})).json();
    expect(keyed.result.tools).toHaveLength(21);
  });
});

describe('T-18 hosted limits', () => {
  it('the 31st request in a minute from one IP is 429 before touching the API', async () => {
    const {rpc, api} = await start({ip: () => '203.0.113.7'});
    for (let i = 0; i < 30; i += 1) expect((await rpc(list)).status).toBe(200);
    const blocked = await rpc({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'getUserProfile', arguments: {}}}, {'x-1platform-app-key': 'ak-a', 'x-1platform-user-key': 'sk-a'});
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe(-32029);
    expect(api.calls).toHaveLength(0);
  });
  it('an attacker with the public ak from another IP does not lock a legitimate user of that ak out', async () => {
    let ip = '198.51.100.1';
    const {rpc} = await start({ip: () => ip});
    for (let i = 0; i < 40; i += 1) await rpc(list, {'x-1platform-app-key': 'ak-public', 'x-1platform-user-key': `sk-junk-${i}`});
    ip = '198.51.100.2';
    expect((await rpc(list, {'x-1platform-app-key': 'ak-public', 'x-1platform-user-key': 'sk-legit'})).status).toBe(200);
  });
  it('the key-pair limit is 120/min', () => {
    const limiter = new WindowLimiter(120);
    for (let i = 0; i < 120; i += 1) expect(limiter.allow('pair')).toBe(true);
    expect(limiter.allow('pair')).toBe(false);
  });
  it('20 000 distinct keys keep memory at 10 000 entries', () => {
    const limiter = new WindowLimiter(30);
    for (let i = 0; i < 20_000; i += 1) limiter.allow(`ip-${i}`);
    expect(limiter.size).toBe(10_000);
  });
  it('a body over 256 KiB is 413', async () => {
    const {rpc} = await start();
    const r = await rpc(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}}`);
    expect(r.status).toBe(413);
  });
  it('the environment cannot be changed by a request header', async () => {
    const {rpc, api} = await start();
    await rpc({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'getUserProfile', arguments: {}}}, {'x-1platform-app-key': 'ak-a', 'x-1platform-user-key': 'sk-a', 'x-oneplatform-env': 'prod'});
    expect(api.calls.every((c) => c.url.startsWith('https://api-qa.1platform.pro/'))).toBe(true);
    expect(api.calls.length).toBeGreaterThan(0);
  });
});
