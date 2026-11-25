/**
 * Tools grouped by product vertical. Without a selection every toolset is
 * listed; ONEPLATFORM_TOOLSETS (local) or the X-OnePlatform-Toolsets header
 * (hosted) narrow it, e.g. `payments,shipping`, for clients that cap how many
 * tools they load. `account` (profile, balance, businesses — where `businessId`
 * comes from) and the documentation tools are always listed.
 *
 * Up to 0.3.0 the toolsets had Spanish names (`pagos`, `envios`…). Those names
 * keep working as aliases so existing configurations do not break.
 *
 * Mirror of TOOLSETS in scripts/build-tools.mjs (a test keeps them equal).
 */
export const TOOLSETS = ['account', 'payments', 'payouts', 'subscriptions', 'terminal', 'invoicing', 'shipping', 'sites', 'analytics', 'email', 'domains', 'telemetry', 'sales', 'agents', 'scheduling', 'social', 'tasks', 'studio', 'prospecting', 'coupons'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Spanish names used up to 0.3.0, still accepted so existing configurations keep working. */
export const LEGACY_TOOLSET_ALIASES: Readonly<Record<string, Toolset>> = {
  cuenta: 'account',
  pagos: 'payments',
  retiros: 'payouts',
  suscripciones: 'subscriptions',
  facturacion: 'invoicing',
  envios: 'shipping',
  sitios: 'sites',
  analitica: 'analytics',
  correo: 'email',
  dominios: 'domains',
  telemetria: 'telemetry',
  ventas: 'sales',
  agentes: 'agents',
  agenda: 'scheduling',
  redes: 'social',
  tareas: 'tasks',
  estudio: 'studio',
  prospeccion: 'prospecting',
  cupones: 'coupons',
};

export class UnknownToolset extends Error {}

const canonical = (name: string): string => LEGACY_TOOLSET_ALIASES[name] ?? name;

/** `undefined` = every toolset. Throws UnknownToolset on a name that does not exist. */
export function parseToolsets(value: string | undefined): ReadonlySet<string> | undefined {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.includes('all') || names.includes('todos')) return undefined;
  const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(canonical(n)));
  if (unknown.length) throw new UnknownToolset(`Unknown toolset: ${unknown.join(', ')}. Available: ${TOOLSETS.join(', ')}.`);
  return new Set(['account', ...names.map(canonical)]);
}
