import {Lru} from './lru.js';
import {digest} from './hash.js';

/**
 * Exchanges the long-lived keys for the two JWTs the API wants, and remembers
 * them (D-8).
 *
 * - App JWT keyed by sha256(ak); user JWT keyed by sha256(ak‖sk); both reused
 *   until two minutes before `exp`, and each key exchanges at most once at a
 *   time (single-flight): ten concurrent calls with cold keys cost one exchange
 *   of each.
 * - A failed exchange is remembered for 60 s AT ITS OWN LEVEL. A junk `sk` is
 *   cached against (ak, sk) and never touches the app JWT, so somebody holding a
 *   public `ak` and cycling `sk` values cannot make us re-exchange that `ak`
 *   (the API caps `/auth/token` per key).
 * - Evicting the app JWT after a 401 has a 60 s cooldown per `ak`: a persistent
 *   401 cannot force an app exchange on every call.
 * - Everything lives in bounded LRUs; the keys themselves are never stored.
 */
export type Exchange = {ok: true; token: string} | {ok: false; status: number; body: string};

type Cached = {token: string; refreshAt: number};
type Failed = {status: number; body: string; until: number};

export interface TokenBrokerOptions {
  apiBase: string;
  fetch: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  timeoutMs?: number;
}

const SAFETY_MS = 120_000;
const NEGATIVE_MS = 60_000;
const APP_EVICT_COOLDOWN_MS = 60_000;
const DEFAULT_TTL_S = 1800;

export class TokenBroker {
  private readonly apps: Lru<string, Cached>;
  private readonly users: Lru<string, Cached>;
  private readonly failedApps: Lru<string, Failed>;
  private readonly failedUsers: Lru<string, Failed>;
  private readonly appEvictions: Lru<string, number>;
  private readonly inflight = new Map<string, Promise<Exchange>>();
  private readonly now: () => number;
  /** Exchanges actually sent to the API, by level. Tests read it; nothing else does. */
  readonly exchanges = {app: 0, user: 0};

  constructor(private readonly options: TokenBrokerOptions) {
    const max = options.maxEntries ?? 10_000;
    this.apps = new Lru(max);
    this.users = new Lru(max);
    this.failedApps = new Lru(max);
    this.failedUsers = new Lru(max);
    this.appEvictions = new Lru(max);
    this.now = options.now ?? Date.now;
  }

  async appToken(ak: string): Promise<Exchange> {
    const key = digest(ak);
    return this.resolve(`app:${key}`, this.apps, this.failedApps, key, () => this.exchange('app', '/auth/token', ak));
  }

  async userToken(ak: string, sk: string): Promise<Exchange> {
    const app = await this.appToken(ak);
    if (!app.ok) return app;
    const key = digest(ak, sk);
    return this.resolve(`user:${key}`, this.users, this.failedUsers, key, () => this.exchange('user', '/users/token', sk, app.token));
  }

  evictUser(ak: string, sk: string): void {
    this.users.delete(digest(ak, sk));
  }

  /** Returns false (and keeps the app JWT) inside the per-`ak` cooldown. */
  evictApp(ak: string): boolean {
    const key = digest(ak);
    const last = this.appEvictions.get(key);
    const now = this.now();
    if (last !== undefined && now - last < APP_EVICT_COOLDOWN_MS) return false;
    this.appEvictions.set(key, now);
    this.apps.delete(key);
    return true;
  }

  get cacheSizes(): {apps: number; users: number; failedApps: number; failedUsers: number} {
    return {apps: this.apps.size, users: this.users.size, failedApps: this.failedApps.size, failedUsers: this.failedUsers.size};
  }

  private async resolve(flightKey: string, cache: Lru<string, Cached>, failed: Lru<string, Failed>, key: string, run: () => Promise<{result: Exchange; ttl?: number}>): Promise<Exchange> {
    const now = this.now();
    const hit = cache.get(key);
    if (hit && hit.refreshAt > now) return {ok: true, token: hit.token};
    const miss = failed.get(key);
    if (miss && miss.until > now) return {ok: false, status: miss.status, body: miss.body};
    const pending = this.inflight.get(flightKey);
    if (pending) return pending;
    const flight = run()
      .then(({result, ttl}) => {
        if (result.ok) {
          cache.set(key, {token: result.token, refreshAt: this.now() + (ttl ?? DEFAULT_TTL_S) * 1000 - SAFETY_MS});
          failed.delete(key);
        } else if (result.status >= 400 && result.status < 500) {
          failed.set(key, {status: result.status, body: result.body, until: this.now() + NEGATIVE_MS});
        }
        return result;
      })
      .finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, flight);
    return flight;
  }

  private async exchange(level: 'app' | 'user', path: string, apiKey: string, appToken?: string): Promise<{result: Exchange; ttl?: number}> {
    this.exchanges[level] += 1;
    const headers: Record<string, string> = {'content-type': 'application/json', accept: 'application/json'};
    if (appToken) headers.authorization = `Bearer ${appToken}`;
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({apiKey}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      return {result: {ok: false, status: 502, body: JSON.stringify({error: 'No se pudo contactar a la OnePlatform API.'})}};
    }
    const body = await response.text();
    if (!response.ok) return {result: {ok: false, status: response.status, body}};
    try {
      const parsed = JSON.parse(body) as {data?: {access_token?: unknown; expires_in?: unknown}};
      const token = parsed.data?.access_token;
      if (typeof token !== 'string' || !token) throw new Error('missing token');
      const ttl = typeof parsed.data?.expires_in === 'number' ? parsed.data.expires_in : undefined;
      return {result: {ok: true, token}, ttl};
    } catch {
      return {result: {ok: false, status: 502, body: JSON.stringify({error: 'La OnePlatform API devolvió un canje ilegible.'})}};
    }
  }
}
