#!/usr/bin/env node
/**
 * Copy of the public OnePlatform OpenAPI used to GENERATE the tools (mirror of the
 * portal's scripts/fetch-openapi.mjs). Not committed: the generated
 * src/generated/tools.ts is, and CI re-derives it with OPENAPI_FETCH_STRICT=1 so
 * a stale spec cannot hide a drift. The URL is never printed: an override may
 * carry credentials.
 */
import {mkdir, writeFile, access} from 'node:fs/promises';

const url = process.env.ONEP_API_OPENAPI_URL || 'https://developer.1platform.pro/openapi/1platform-api.json';
const out = new URL('../openapi/1platform-api.json', import.meta.url);
const strict = process.env.OPENAPI_FETCH_STRICT === '1';

try {
  const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const spec = await response.json();
  if (!spec.paths || typeof spec.paths !== 'object') throw new Error('not an OpenAPI document');
  await mkdir(new URL('../openapi/', import.meta.url), {recursive: true});
  await writeFile(out, JSON.stringify(spec));
  console.log(`fetch-openapi: ${Object.keys(spec.paths).length} paths`);
} catch (error) {
  if (strict) {
    console.error(`fetch-openapi: failed (${error.message}); strict mode does not fall back to the cache`);
    process.exit(1);
  }
  try {
    await access(out);
    console.warn(`WARN fetch-openapi: failed (${error.message}); using the cached copy, which may be stale`);
  } catch {
    console.error(`fetch-openapi: failed (${error.message}) and there is no cached copy`);
    process.exit(1);
  }
}
