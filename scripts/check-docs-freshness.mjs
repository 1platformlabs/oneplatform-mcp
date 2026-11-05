#!/usr/bin/env node
// Compare the structural contract read by api_get_operation with the live API.
// Metadata and sanitized examples may differ; paths, field names and validation may not.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const METADATA = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);
const MAPS = new Set(['paths', 'properties', 'schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'content', 'securitySchemes', '$defs', 'patternProperties']);
function normalize(value, map = false) {
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => map || !METADATA.has(key))
    .map(([key, child]) => [key, normalize(child, !map && MAPS.has(key))]));
}
function validate(spec) {
  if (!spec?.openapi || !spec.paths || !Object.keys(spec.paths).length) throw new Error('Expected a populated OpenAPI document');
}
export function compareContracts(portal, live) {
  validate(portal); validate(live);
  const hash = spec => createHash('sha256').update(JSON.stringify(normalize({paths: spec.paths, components: spec.components, security: spec.security}))).digest('hex');
  const count = spec => Object.values(spec.paths).reduce((n, item) => n + Object.values(item).filter(op => op && typeof op === 'object' && op.operationId).length, 0);
  return {current: hash(portal) === hash(live), portalOperations: count(portal), liveOperations: count(live)};
}
// The portal contract is ~7 MB; from CI runners 30 s was not always enough (issue #10).
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const DOWNLOAD_ATTEMPTS = 2;
class HttpStatusError extends Error {}
export async function checkFreshness({fetchImpl = fetch, portalUrl = 'https://developer.1platform.pro/openapi/1platform-api.json', liveUrl = 'https://api.1platform.pro/openapi.json'} = {}) {
  // fetch already negotiates gzip/deflate; the budget covers download and body parsing.
  const attempt = async url => {
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)});
    if (!response.ok) throw new HttpStatusError('Contract download failed');
    return response.json();
  };
  // One retry for network errors and timeouts only: an HTTP error or an invalid body is an answer, not a blip.
  const read = (url, left = DOWNLOAD_ATTEMPTS) => attempt(url).catch(error => {
    if (left <= 1 || error instanceof HttpStatusError || error instanceof SyntaxError) throw error;
    return read(url, left - 1);
  });
  const [portal, live] = await Promise.all([read(portalUrl), read(liveUrl)]);
  return compareContracts(portal, live);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkFreshness({portalUrl: process.env.ONEPLATFORM_DOCS_OPENAPI_URL, liveUrl: process.env.ONEP_API_OPENAPI_URL});
    console.log(`Documentation contract: ${result.current ? 'current' : 'STALE'}; portal=${result.portalOperations}, API=${result.liveOperations}`);
    if (!result.current) process.exitCode = 1;
  } catch {
    // URLs, bodies and parser exceptions may contain sensitive configuration.
    console.error('Unable to verify documentation freshness; no cached fallback.');
    process.exitCode = 1;
  }
}
