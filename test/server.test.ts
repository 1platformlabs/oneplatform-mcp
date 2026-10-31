import {API_TOOLS} from '../src/generated/tools.js';
import {describe, expect, it, vi} from 'vitest';

import {TokenBroker} from '../src/auth/token-cache.js';
import {parseEnv, API_BASES} from '../src/config.js';
import {MAX_RESPONSE_BYTES} from '../src/http/api-client.js';
import {buildPath, PathRejected} from '../src/http/path-guard.js';
import {connect, fakeApi, KEYS, QA} from './helpers.js';

type Text = {content: Array<{type: string; text: string}>; isError?: boolean};
const call = async (client: Awaited<ReturnType<typeof connect>>['client'], name: string, args: Record<string, unknown> = {}) => (await client.callTool({name, arguments: args})) as Text;

describe('IPA-04 CA-1/CA-2 tools/list', () => {
  it('without keys: only the three docs tools', async () => {
    const {client} = await connect({fetch: fakeApi().fetch});
    const {tools} = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['docs_search', 'docs_get_page', 'api_get_operation']);
  });

  it('with keys: docs tools plus exactly the manifest, writes marked destructive', async () => {
    const {client} = await connect({fetch: fakeApi().fetch, credentials: KEYS});
    const {tools} = await client.listTools();
    expect(tools).toHaveLength(3 + API_TOOLS.length);
    const create = tools.find((t) => t.name === 'createPaymentLink')!;
    expect(create.annotations).toMatchObject({readOnlyHint: false, destructiveHint: true});
    expect(tools.find((t) => t.name === 'getUserProfile')!.annotations).toMatchObject({readOnlyHint: true, destructiveHint: false});
  });
});

describe('IPA-04 CA-4 an API tool without keys', () => {
  it('answers isError pointing to the integration page and never touches the network', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch});
    const result = await call(client, 'getUserProfile');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('/docs/saas/1platform-api/integrar-con-ia');
    expect(api.calls).toHaveLength(0);
  });
});

describe('T-15 QA by default', () => {
  it('no ONEPLATFORM_ENV means api-qa; anything but qa/prod is rejected', () => {
    expect(API_BASES[parseEnv(undefined)]).toBe('https://api-qa.1platform.pro/api/v1');
    expect(API_BASES[parseEnv('prod')]).toBe('https://api.1platform.pro/api/v1');
    expect(() => parseEnv('production')).toThrow(/qa.*prod/);
  });
});

describe('T-11 path guard', () => {
  const template = '/api/v1/businesses/{businessId}/payment-links/{linkId}';
  it.each(['x/../../balance/topups', '..', '%2e%2e', 'a/b', 'a%2Fb', '', 'x'.repeat(65)])('rejects %j with zero calls', async (bad) => {
    expect(() => buildPath(template, {businessId: bad, linkId: 'ok'}, {})).toThrow(PathRejected);
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getPaymentLink', {businessId: bad, linkId: 'abc'});
    expect(result.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
  it('accepts an ordinary id', () => {
    expect(buildPath(template, {businessId: '65f0a1b2c3d4e5f6a7b8c9d0', linkId: 'pl_123'}, {})).toBe('/api/v1/businesses/65f0a1b2c3d4e5f6a7b8c9d0/payment-links/pl_123');
  });
});

describe('T-10 an omitted field the model sends anyway', () => {
  it('is dropped before the POST', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    await call(client, 'createPaymentLink', {businessId: 'b1', amount: 10, concept: 'x', customer_email: 'tercero@example.com'});
    const post = api.calls.find((c) => c.url.endsWith('/payment-links'))!;
    expect(JSON.parse(post.body!)).toEqual({amount: 10, concept: 'x'});
  });
});

describe('IPA-04 CA-9 raw body, status and list limit', () => {
  it('passes the API body and status through, framed as untrusted data', async () => {
    const api = fakeApi(() => ({status: 404, body: {detail: 'Business not found'}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getBusiness', {businessId: 'b1'});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('HTTP 404');
    expect(result.content[0]!.text).toContain('{"detail":"Business not found"}');
    expect(result.content[0]!.text).toContain('no instrucciones');
  });
  it('lists get limit=20 unless the model asks otherwise', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    await call(client, 'listPaymentLinks', {businessId: 'b1'});
    await call(client, 'listPaymentLinks', {businessId: 'b1', limit: 5});
    const lists = api.calls.filter((c) => c.url.includes('/payment-links?'));
    expect(lists.map((c) => new URL(c.url).searchParams.get('limit'))).toEqual(['20', '5']);
  });
  it('sends both tokens and goes to QA', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    await call(client, 'getUserProfile');
    const profile = api.calls.find((c) => c.url.endsWith('/users/profile'))!;
    expect(profile.url).toBe(`${QA}/users/profile`);
    expect(profile.headers.authorization).toMatch(/^Bearer jwt-app-/);
    expect(profile.headers['x-user-token']).toMatch(/^jwt-user-/);
  });
});

describe('T-20 truncation', () => {
  it('a 300 KiB response is cut to 100 KiB with a notice', async () => {
    const api = fakeApi(() => ({status: 200, body: 'x'.repeat(300 * 1024)}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getUserProfile');
    const text = result.content[0]!.text;
    expect(text).toContain('Respuesta recortada a 100 KiB');
    expect(text.match(/x{1000,}/)![0].length).toBe(MAX_RESPONSE_BYTES);
  });
});

describe('T-22 redaction at runtime', () => {
  it('bank_authorization and the site token never reach the model', async () => {
    const api = fakeApi((c) => (c.url.includes('/transactions/')
      ? {status: 200, body: {success: true, data: {id: 't1', bank_authorization: '123456', nested: [{bank_authorization: '9'}]}}}
      : {status: 200, body: {success: true, data: {id: 'w1', token: 'site-secret', token_expiry: 'x', name: 'Mi sitio'}}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const tx = (await call(client, 'getPaymentTransactionById', {transaction_id: 't1'})).content[0]!.text;
    expect(tx).not.toContain('bank_authorization');
    expect(tx).toContain('"id":"t1"');
    const site = (await call(client, 'getWebsite', {website_id: 'w1'})).content[0]!.text;
    expect(site).not.toContain('site-secret');
    expect(site).toContain('Mi sitio');
  });
});

describe('T-12 cache and single-flight', () => {
  it('10 concurrent calls with cold keys exchange once per level', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    await Promise.all(Array.from({length: 10}, () => call(client, 'getUserProfile')));
    expect(api.count('/auth/token')).toBe(1);
    expect(api.count('/users/token')).toBe(1);
    expect(api.count('/users/profile')).toBe(10);
  });
  it('a token is reused until two minutes before it expires', async () => {
    let now = 0;
    const api = fakeApi();
    const broker = new TokenBroker({apiBase: QA, fetch: api.fetch, now: () => now});
    await broker.userToken('ak-a', 'sk-a');
    now = (1800 - 121) * 1000;
    await broker.userToken('ak-a', 'sk-a');
    expect(api.count('/auth/token')).toBe(1);
    now = (1800 - 119) * 1000;
    await broker.userToken('ak-a', 'sk-a');
    expect(api.count('/auth/token')).toBe(2);
  });
});

describe('T-13 / T-25 401 in two steps; 429 is not retried', () => {
  it('401 → user JWT evicted and one retry', async () => {
    let first = true;
    const api = fakeApi((c) => {
      if (c.url.endsWith('/users/profile') && first) { first = false; return {status: 401, body: {detail: 'Token expired'}}; }
      return {status: 200, body: {success: true, data: {}, msg: 'ok'}};
    });
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getUserProfile');
    expect(result.isError).toBeUndefined();
    expect(api.count('/users/profile')).toBe(2);
    expect(api.count('/users/token')).toBe(2);
    expect(api.count('/auth/token')).toBe(1);
  });
  it('401, 401, 401 → user, then app, then the error; three calls, three re-exchanges at most', async () => {
    const api = fakeApi((c) => (c.url.endsWith('/users/profile') ? {status: 401, body: {detail: 'Invalid token'}} : {status: 200, body: {}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getUserProfile');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('{"detail":"Invalid token"}');
    expect(api.count('/users/profile')).toBe(3);
    expect(api.count('/auth/token')).toBe(2);
    expect(api.count('/users/token')).toBe(3);
  });
  it('429 is returned at once', async () => {
    const api = fakeApi((c) => (c.url.endsWith('/users/profile') ? {status: 429, body: {detail: 'Too many'}} : {status: 200, body: {}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    const result = await call(client, 'getUserProfile');
    expect(result.content[0]!.text).toContain('HTTP 429');
    expect(api.count('/users/profile')).toBe(1);
  });
});

describe('T-25b app eviction cooldown', () => {
  it('a persistent 401 in 5 calls within 60 s re-issues the app JWT once', async () => {
    const api = fakeApi((c) => (c.url.endsWith('/users/profile') ? {status: 401, body: {detail: 'Invalid token'}} : {status: 200, body: {}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    for (let i = 0; i < 5; i += 1) await call(client, 'getUserProfile');
    expect(api.count('/auth/token')).toBe(2);
  });
});

describe('T-14 / T-24 negative cache per level', () => {
  it('the same invalid sk ×5 in 60 s → one user exchange', async () => {
    const api = fakeApi((c) => (c.url.endsWith('/users/token') ? {status: 401, body: {success: false, data: null, msg: 'Invalid API key'}} : {status: 200, body: {}}));
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    for (let i = 0; i < 5; i += 1) await call(client, 'getUserProfile');
    expect(api.count('/users/token')).toBe(1);
    expect(api.count('/users/profile')).toBe(0);
  });
  it('a valid ak with 5 junk sk → 1 app exchange, 5 user exchanges, app JWT intact', async () => {
    const api = fakeApi((c) => (c.url.endsWith('/users/token') ? {status: 401, body: {success: false, data: null, msg: 'Invalid API key'}} : {status: 200, body: {}}));
    const broker = new TokenBroker({apiBase: QA, fetch: api.fetch});
    for (let i = 0; i < 5; i += 1) expect((await broker.userToken('ak-public', `sk-junk-${i}`)).ok).toBe(false);
    expect(api.count('/auth/token')).toBe(1);
    expect(api.count('/users/token')).toBe(5);
    expect((await broker.appToken('ak-public')).ok).toBe(true);
    expect(api.count('/auth/token')).toBe(1);
  });
  it('the negative cache expires after 60 s', async () => {
    let now = 0;
    const api = fakeApi((c) => (c.url.endsWith('/auth/token') ? {status: 401, body: {msg: 'no'}} : {status: 200, body: {}}));
    const broker = new TokenBroker({apiBase: QA, fetch: api.fetch, now: () => now});
    await broker.appToken('ak-bad');
    now = 59_000;
    await broker.appToken('ak-bad');
    expect(api.count('/auth/token')).toBe(1);
    now = 61_000;
    await broker.appToken('ak-bad');
    expect(api.count('/auth/token')).toBe(2);
  });
});

describe('T-19 no 401 oracle', () => {
  it('a bad ak and a bad sk come back with the API own status and body', async () => {
    const appBody = {success: false, data: null, msg: 'Invalid API key'};
    const userBody = {success: false, data: null, msg: 'Invalid API key'};
    const badApp = fakeApi((c) => (c.url.endsWith('/auth/token') ? {status: 401, body: appBody} : {status: 200, body: {}}));
    const badUser = fakeApi((c) => (c.url.endsWith('/users/token') ? {status: 401, body: userBody} : {status: 200, body: {}}));
    const a = await call((await connect({fetch: badApp.fetch, credentials: KEYS})).client, 'getUserProfile');
    const u = await call((await connect({fetch: badUser.fetch, credentials: KEYS})).client, 'getUserProfile');
    expect(a.content[0]!.text).toBe(u.content[0]!.text);
    expect(a.content[0]!.text).toContain(JSON.stringify(appBody));
  });
});

describe('T-16 keys never reach a log', () => {
  it('stdout and stderr of a run carry no key and no JWT', async () => {
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    const {logLine} = await import('../src/log.js');
    try {
      const api = fakeApi((c) => (c.url.endsWith('/users/profile') ? {status: 401, body: {detail: 'x'}} : {status: 200, body: {}}));
      const {client} = await connect({fetch: api.fetch, credentials: {appKey: 'ak-SENTINEL-APP', userKey: 'sk-SENTINEL-USER'}, log: logLine});
      await call(client, 'getUserProfile');
      await call(client, 'createPaymentLink', {businessId: 'b', amount: 1, concept: 'c'});
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const all = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/SENTINEL|jwt-(app|user)/);
    expect(all).toMatch(/"tool":"getUserProfile"/);
  });
});

describe('T-10 the runtime omit filter on its own', () => {
  it('drops an omitted field even if the generated tool still lists it as a body field', async () => {
    // The generator already removes omitted fields from bodyParams, which hides
    // this filter from the end-to-end test above. This case isolates it: a tool
    // whose bodyParams were edited by hand must still not send the field.
    const {prepare} = await import('../src/http/api-client.js');
    const {API_TOOLS} = await import('../src/generated/tools.js');
    const tool = {...API_TOOLS.find((t) => t.name === 'createPaymentLink')!, bodyParams: ['amount', 'concept', 'customer_email']};
    expect(prepare(tool, {businessId: 'b', amount: 1, concept: 'c', customer_email: 'tercero@example.com'}).body).toEqual({amount: 1, concept: 'c'});
  });
});
