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
