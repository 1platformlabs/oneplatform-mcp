/**
 * Fixed routes (D-11). A tool can only reach the URL template of its own
 * operationId: every path parameter is checked against its pattern (the spec's,
 * or `^[A-Za-z0-9_-]{1,64}$`), encoded, and the final path is compared segment
 * by segment with the template. Without this, `businessId: "x/../../balance/topups"`
 * would walk an allowed tool into a denied operation.
 */
export class PathRejected extends Error {
  constructor(readonly param: string) {
    super(`El parámetro de ruta «${param}» no tiene un formato válido.`);
  }
}

export const DEFAULT_PATH_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

export function buildPath(template: string, values: Record<string, unknown>, patterns: Record<string, string>): string {
  const filled = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const raw = values[name];
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new PathRejected(name);
    const value = String(raw);
    const pattern = new RegExp(patterns[name] ?? DEFAULT_PATH_PATTERN);
    if (!pattern.test(value) || /[/\\%]|\.\./.test(value)) throw new PathRejected(name);
    return encodeURIComponent(value);
  });
  const want = template.split('/');
  const got = filled.split('/');
  const same = want.length === got.length && want.every((segment, i) => {
    const actual = got[i] ?? '';
    if (!/^\{[^}]+\}$/.test(segment)) return segment === actual;
    return actual !== '' && actual !== '.' && actual !== '..' && !actual.includes('/');
  });
  if (!same) throw new PathRejected('ruta');
  return filled;
}
