/**
 * One JSON line per tools/call on stderr (stdout belongs to the stdio
 * protocol). Fields are fixed by the callers — tool, status, duration and the
 * first 8 hex chars of sha256(ak) — so no key or token can reach it.
 */
export function logLine(line: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({at: new Date().toISOString(), ...line})}\n`);
}
