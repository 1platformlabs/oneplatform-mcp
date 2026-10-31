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
