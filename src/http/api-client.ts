import {digest} from '../auth/hash.js';
import type {TokenBroker} from '../auth/token-cache.js';
import type {Credentials} from '../config.js';
import {buildPath, PathRejected} from './path-guard.js';
import type {ApiTool} from '../generated/tools.js';

/**
 * One call of an allowlisted operation (D-8 · D-10 · D-11).
 *
 * The answer is the API's own body and status, never reshaped: auth errors
 * come as `{detail}`, business errors as `{success, data, msg}`, and an agent
 * that reads the docs must see what the docs describe. Two things are done to
 * it, both declared: keys listed in the tool's `redact` are removed, and the
 * text is cut at 100 KiB with a notice.
 */
export const MAX_RESPONSE_BYTES = 100 * 1024;
export const DEFAULT_LIST_LIMIT = 20;

export interface CallResult {
  status: number;
  body: string;
  truncated: boolean;
}

export class MissingCredentials extends Error {
  constructor() {
    super('Esta herramienta necesita las claves de 1Platform (ONEPLATFORM_APP_KEY y ONEPLATFORM_USER_KEY). Cómo pedirlas y configurarlas: https://developer.1platform.pro/docs/saas/1platform-api/integrar-con-ia');
  }
}

export interface ApiDeps {
  apiBase: string;
  fetch: typeof fetch;
  broker: TokenBroker;
  log?: (line: Record<string, unknown>) => void;
  timeoutMs?: number;
}

export function redact(value: unknown, keys: readonly string[]): unknown {
  if (!keys.length) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, keys));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) continue;
      out[k] = redact(v, keys);
    }
    return out;
  }
  return value;
}

export function truncate(text: string): {text: string; truncated: boolean} {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_RESPONSE_BYTES) return {text, truncated: false};
  const cut = bytes.subarray(0, MAX_RESPONSE_BYTES).toString('utf8').replace(/�$/, '');
  return {text: cut, truncated: true};
}

/** Only declared arguments survive; `omit`ted ones are dropped even if the model sends them. */
export function prepare(tool: ApiTool, args: Record<string, unknown>): {path: string; query: URLSearchParams; body?: Record<string, unknown>} {
  const known = (name: string) => args[name] !== undefined && args[name] !== null && !tool.omit.includes(name);
  const path = buildPath(tool.path, args, tool.pathPatterns);
  const query = new URLSearchParams();
  for (const name of tool.queryParams) {
    if (known(name)) query.set(name, String(args[name]));
  }
  if (tool.queryParams.includes('limit') && !query.has('limit')) query.set('limit', String(DEFAULT_LIST_LIMIT));
  let body: Record<string, unknown> | undefined;
  if (tool.bodyParams.length) {
    body = {};
    for (const name of tool.bodyParams) {
      if (known(name)) body[name] = args[name];
    }
  }
  return {path, query, body};
}

export async function callApi(tool: ApiTool, args: Record<string, unknown>, credentials: Credentials | undefined, deps: ApiDeps): Promise<CallResult> {
  if (!credentials) throw new MissingCredentials();
  const prepared = prepare(tool, args);
  const started = Date.now();
  const {appKey, userKey} = credentials;
  const url = `${deps.apiBase}${prepared.path.replace(/^\/api\/v1/, '')}${prepared.query.size ? `?${prepared.query}` : ''}`;

  const send = async (): Promise<CallResult> => {
    const user = await deps.broker.userToken(appKey, userKey);
    if (!user.ok) return {status: user.status, body: user.body, truncated: false};
    const app = await deps.broker.appToken(appKey);
    if (!app.ok) return {status: app.status, body: app.body, truncated: false};
    const headers: Record<string, string> = {authorization: `Bearer ${app.token}`, 'x-user-token': user.token, accept: 'application/json'};
    if (prepared.body) headers['content-type'] = 'application/json';
    try {
      const response = await deps.fetch(url, {
        method: tool.method,
        headers,
        body: prepared.body ? JSON.stringify(prepared.body) : undefined,
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      });
      return {status: response.status, body: await response.text(), truncated: false};
    } catch {
      return {status: 504, body: JSON.stringify({error: 'La 1Platform API no respondió a tiempo.'}), truncated: false};
    }
  };

  // A 401 does not say which token failed (the API's texts carry no code), so
  // the user JWT goes first and the app JWT second; at most three exchanges.
  let result = await send();
  if (result.status === 401) {
    deps.broker.evictUser(appKey, userKey);
    result = await send();
    if (result.status === 401 && deps.broker.evictApp(appKey)) {
      deps.broker.evictUser(appKey, userKey);
      result = await send();
    }
  }

  let text = result.body;
  if (tool.redact.length) {
    try {
      text = JSON.stringify(redact(JSON.parse(text), tool.redact));
    } catch {
      // Not JSON: nothing to redact by key.
    }
  }
  const cut = truncate(text);
  deps.log?.({tool: tool.name, status: result.status, duration_ms: Date.now() - started, ak: digest(appKey).slice(0, 8)});
  return {status: result.status, body: cut.text, truncated: cut.truncated};
}

export {PathRejected};
