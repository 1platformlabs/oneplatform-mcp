import type {AddressInfo} from 'node:net';
import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';

import {apiBaseFromEnv} from '../src/config.js';
import {buildHops} from '../src/http/client-address.js';
import {Docs} from '../src/tools/docs.js';
import {createHttpHandler} from '../src/transports/http.js';
import {DOCS, fakeApi} from './helpers.js';

const CF_EDGE = '162.158.90.12';
const open: Array<() => Promise<void>> = [];
afterEach(async () => { while (open.length) await open.pop()!(); });

async function start(apiBase?: string) {
  const api = fakeApi((call) => call.url.endsWith('/auth/token') || call.url.endsWith('/auth/user-token')
    ? {status: 200, body: {success: true, data: {access_token: 'jwt', token: 'jwt', expires_in: 1800}, msg: 'ok'}}
    : {status: 200, body: {success: true, data: {}, msg: 'ok'}});
  const handler = createHttpHandler({env: 'qa', apiBase, fetch: api.fetch, docs: new Docs({docsBase: DOCS, fetch: api.fetch}), hops: buildHops(['185.125.168.236/32'])});
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: JSON.stringify(body)});
  return {api, rpc};
}

const keys = {'x-oneplatform-app-key': 'ak-a', 'x-oneplatform-user-key': 'sk-a'};
const call = (name: string, args: Record<string, unknown> = {}) => ({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name, arguments: args}});
const list = {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}};

describe('IPA-05 · D-12 hacia el API', () => {
  it('cada llamada al API lleva X-Forwarded-For nuevo con el cliente resuelto, nunca lo que mandó el cliente', async () => {
    const {api, rpc} = await start();
    // peer 127.0.0.1 es un salto nuestro; el cliente según Cloudflare es 203.0.113.7; lo de la izquierda es falso
    await rpc(call('getUserProfile'), {...keys, 'x-forwarded-for': `6.6.6.6, 203.0.113.7, ${CF_EDGE}`});
    const upstream = api.calls.filter((c) => c.url.startsWith('https://api-qa.1platform.pro/'));
    expect(upstream.length).toBeGreaterThanOrEqual(2); // canje(s) + la operación
    for (const c of upstream) expect(c.headers['x-forwarded-for']).toBe('203.0.113.7');
  });
  it('la documentación no recibe la IP del cliente', async () => {
    const {api, rpc} = await start();
    await rpc(call('docs_search', {query: 'links'}), {'x-forwarded-for': `203.0.113.7, ${CF_EDGE}`});
    const docsCalls = api.calls.filter((c) => c.url.startsWith(DOCS));
    expect(docsCalls.length).toBeGreaterThan(0);
    for (const c of docsCalls) expect(c.headers['x-forwarded-for']).toBeUndefined();
  });
  it('apiBase interna: las llamadas van al API del mismo host, no al público', async () => {
    const {api, rpc} = await start('http://1platform-api-qa:3005/api/v1');
    await rpc(call('getUserProfile'), {...keys, 'x-forwarded-for': `203.0.113.7, ${CF_EDGE}`});
    const hosts = new Set(api.calls.filter((c) => !c.url.startsWith(DOCS)).map((c) => new URL(c.url).origin));
    expect([...hosts]).toEqual(['http://1platform-api-qa:3005']);
  });
});

describe('IPA-05 · CA-3 límite propio por cliente resuelto', () => {
  it('dos clientes detrás del front door son dos baldes', async () => {
    const {rpc} = await start();
    const as = (ip: string) => rpc(list, {'x-forwarded-for': `${ip}, ${CF_EDGE}`});
    for (let i = 0; i < 30; i += 1) expect((await as('203.0.113.7')).status).toBe(200);
    expect((await as('203.0.113.7')).status).toBe(429);
    expect((await as('198.51.100.9')).status).toBe(200);
  });
  it('rotar la parte falsificada del encabezado no da baldes nuevos', async () => {
    const {rpc} = await start();
    for (let i = 0; i < 30; i += 1) await rpc(list, {'x-forwarded-for': `9.9.9.${i}, 203.0.113.7, ${CF_EDGE}`});
    expect((await rpc(list, {'x-forwarded-for': `1.1.1.1, 203.0.113.7, ${CF_EDGE}`})).status).toBe(429);
  });
});

describe('X-OnePlatform-Toolsets en el alojado', () => {
  it('acota la lista y un nombre desconocido es 400', async () => {
    const {rpc} = await start();
    const narrowed = await (await rpc(list, {...keys, 'x-oneplatform-toolsets': 'envios'})).json();
    expect(narrowed.result.tools.map((t: {name: string}) => t.name)).toContain('listDeliveries');
    expect(narrowed.result.tools.map((t: {name: string}) => t.name)).not.toContain('listInvoices');
    const bad = await rpc(list, {...keys, 'x-oneplatform-toolsets': 'nomina'});
    expect(bad.status).toBe(400);
  });
});

describe('ONEPLATFORM_API_URL', () => {
  it('acepta la URL interna y la normaliza', () => {
    expect(apiBaseFromEnv('prod', 'http://1platform-api-prod:3005/api/v1/')).toBe('http://1platform-api-prod:3005/api/v1');
    expect(apiBaseFromEnv('qa', undefined)).toBeUndefined();
  });
  for (const bad of ['nope', 'ftp://x/api/v1', 'http://u:p@x/api/v1', 'http://x/otra', 'http://x/api/v1?env=prod'])
    it(`rechaza ${bad}`, () => expect(() => apiBaseFromEnv('qa', bad)).toThrow());
});
