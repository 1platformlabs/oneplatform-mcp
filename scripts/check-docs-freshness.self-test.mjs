import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareContracts, checkFreshness} from './check-docs-freshness.mjs';
const base = () => ({openapi: '3.1.0', paths: {'/profile': {get: {operationId: 'profile', responses: {'200': {description: 'OK'}}}}}, components: {schemas: {Profile: {type: 'object', properties: {description: {type: 'string', maxLength: 20}}}}}});
test('same contract ignores documentation metadata and sanitized examples', () => {
  const other = base(); other.info = {version: 'different-label'}; other.paths['/profile'].get.summary = 'Guide';
  other.components.schemas.Profile.properties.description.example = 'sanitized';
  assert.equal(compareContracts(base(), other).current, true);
});
test('new and removed operations, changed ids and schema constraints fail', () => {
  for (const mutate of [s => {s.paths['/preferences'] = {get: {operationId: 'getUserEmailPreferences'}};}, s => {s.paths['/profile'].get.operationId = 'newProfile';}, s => {s.components.schemas.Profile.properties.description.maxLength = 50;}, s => {delete s.components.schemas.Profile.properties.description;}]) {
    const live = base(); mutate(live); assert.equal(compareContracts(base(), live).current, false);
    assert.equal(compareContracts(live, base()).current, false);
  }
});
test('unreachable or malformed contract fails closed, never declares current', async () => {
  await assert.rejects(checkFreshness({fetchImpl: async () => new Response('unavailable', {status: 503})}));
  await assert.rejects(checkFreshness({fetchImpl: async () => Response.json({paths: {}})}));
  await assert.rejects(checkFreshness({fetchImpl: async () => {throw new Error('offline');}}));
});
test('candidate portal is compared with independently fetched API', async () => {
  const urls = [];
  const result = await checkFreshness({portalUrl: 'https://candidate.example/spec', liveUrl: 'https://api.example/spec', fetchImpl: async url => {urls.push(url); return Response.json(base());}});
  assert.deepEqual(urls, ['https://candidate.example/spec', 'https://api.example/spec']); assert.equal(result.current, true);
});

// Issue #10: a slow 7 MB download from CI was cut at 30 s with no retry.
// AbortSignal.timeout is replaced by a virtual clock so no test waits for real.
function virtualClock(t) {
  let now = 0; const pending = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController(); pending.push({at: now + ms, controller}); return controller.signal;
  });
  return {advance(ms) {
    now += ms;
    for (const {at, controller} of pending) if (at <= now && !controller.signal.aborted) controller.abort(new DOMException('timed out', 'TimeoutError'));
  }};
}
// Download whose body takes `seconds` of virtual time; it honours the abort signal like fetch does.
const slowFetch = (clock, seconds, log = []) => async (url, {signal}) => {
  log.push(url); clock.advance(seconds * 1000);
  if (signal.aborted) throw signal.reason;
  return Response.json(base());
};
test('a 60 s contract download completes within the download budget', async t => {
  const clock = virtualClock(t);
  const result = await checkFreshness({fetchImpl: slowFetch(clock, 60)});
  assert.equal(result.current, true);
});
test('a timed-out download is retried once and the retry recovers', async t => {
  const clock = virtualClock(t); const calls = [];
  let first = true;
  const result = await checkFreshness({portalUrl: 'p', liveUrl: 'l', fetchImpl: async (url, init) => {
    if (url === 'p' && first) { first = false; return slowFetch(clock, 600, calls)(url, init); }
    calls.push(url); return Response.json(base());
  }});
  assert.equal(result.current, true);
  assert.deepEqual(calls.filter(u => u === 'p').length, 2);
});
test('a network error is retried once and the retry recovers', async () => {
  let failures = 1;
  const result = await checkFreshness({fetchImpl: async () => {
    if (failures-- > 0) throw new TypeError('fetch failed');
    return Response.json(base());
  }});
  assert.equal(result.current, true);
});
test('two failed attempts still fail closed; HTTP errors and invalid bodies are not retried', async t => {
  const clock = virtualClock(t); const calls = [];
  await assert.rejects(checkFreshness({portalUrl: 'p', liveUrl: 'p', fetchImpl: slowFetch(clock, 600, calls)}));
  assert.equal(calls.length, 4); // two URLs x two attempts, never a third
  for (const reply of [() => new Response('unavailable', {status: 503}), () => new Response('{not json')]) {
    let n = 0;
    await assert.rejects(checkFreshness({fetchImpl: async () => {n++; return reply();}}));
    assert.equal(n, 2); // one per URL
  }
});
test('CLI: two network failures exit 1 with the same message and no URL', async () => {
  const {createServer} = await import('node:http');
  const {execFile} = await import('node:child_process');
  const hits = new Map();
  const server = createServer((req, res) => { hits.set(req.url, (hits.get(req.url) ?? 0) + 1); req.socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const {code, stdout, stderr} = await new Promise(resolve => execFile(process.execPath, [new URL('./check-docs-freshness.mjs', import.meta.url).pathname], {
      env: {...process.env, ONEPLATFORM_DOCS_OPENAPI_URL: `${origin}/portal-secret`, ONEP_API_OPENAPI_URL: `${origin}/live-secret`},
    }, (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, 'Unable to verify documentation freshness; no cached fallback.\n');
    assert.deepEqual(Object.fromEntries(hits), {'/portal-secret': 2, '/live-secret': 2});
  } finally { server.close(); }
});
