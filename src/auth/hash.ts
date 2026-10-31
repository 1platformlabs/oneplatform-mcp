import {createHash} from 'node:crypto';

/** Keys never become map keys or log fields in clear: only their digest. */
export function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  parts.forEach((part, i) => {
    if (i > 0) hash.update('\u0000');
    hash.update(part);
  });
  return hash.digest('hex');
}
