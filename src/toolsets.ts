/**
 * Tools grouped by product vertical. Without a selection every toolset is
 * listed; ONEPLATFORM_TOOLSETS (local) or the X-OnePlatform-Toolsets header
 * (hosted) narrow it, e.g. `pagos,envios`, for clients that cap how many tools
 * they load. `cuenta` (profile, balance, businesses — where `businessId` comes
 * from) and the documentation tools are always listed.
 *
 * Mirror of TOOLSETS in scripts/build-tools.mjs (a test keeps them equal).
 */
export const TOOLSETS = ['cuenta', 'pagos', 'retiros', 'suscripciones', 'terminal', 'facturacion', 'envios', 'sitios', 'analitica', 'correo', 'dominios', 'telemetria', 'ventas', 'agentes'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export class UnknownToolset extends Error {}

/** `undefined` = every toolset. Throws UnknownToolset on a name that does not exist. */
export function parseToolsets(value: string | undefined): ReadonlySet<string> | undefined {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.includes('all') || names.includes('todos')) return undefined;
  const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(n));
  if (unknown.length) throw new UnknownToolset(`Toolset desconocido: ${unknown.join(', ')}. Disponibles: ${TOOLSETS.join(', ')}.`);
  return new Set(['cuenta', ...names]);
}
