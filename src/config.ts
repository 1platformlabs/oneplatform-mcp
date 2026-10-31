/**
 * Runtime configuration. The environment is QA unless it says `prod`
 * explicitly (D-8): an agent that misreads the docs ends up in QA, never in
 * production. Anything else is a startup error, not a silent default.
 */
export type Env = 'qa' | 'prod';

export const API_BASES: Record<Env, string> = {
  qa: 'https://api-qa.1platform.pro/api/v1',
  prod: 'https://api.1platform.pro/api/v1',
};

export const DEFAULT_DOCS_BASE = 'https://developer.1platform.pro';

export interface Credentials {
  appKey: string;
  userKey: string;
}

export function parseEnv(value: string | undefined): Env {
  if (value === undefined || value === '') return 'qa';
  if (value === 'qa' || value === 'prod') return value;
  throw new Error(`ONEPLATFORM_ENV must be "qa" or "prod", got "${value}"`);
}

export function credentialsFrom(appKey: string | undefined, userKey: string | undefined): Credentials | undefined {
  const a = appKey?.trim();
  const u = userKey?.trim();
  return a && u ? {appKey: a, userKey: u} : undefined;
}

/**
 * Hosted only: the internal URL of THIS deployment's API (same host, Docker
 * network), set by the deployment, never by a request. It must be plain
 * http(s) and end in /api/v1; anything else stops the process.
 */
export function apiBaseFromEnv(env: Env, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`ONEPLATFORM_API_URL is not a URL (env ${env})`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !/\/api\/v1\/?$/.test(url.pathname)) {
    throw new Error(`ONEPLATFORM_API_URL must be http(s)://host[:port]/api/v1 (env ${env})`);
  }
  return url.href.replace(/\/$/, '');
}
