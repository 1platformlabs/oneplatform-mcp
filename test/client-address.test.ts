import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {bucketKey, buildHops, parseTrustedProxyCidrs, resolveClientIp, trustedCidrsFromEnv} from '../src/http/client-address.js';

const spec = JSON.parse(readFileSync(new URL('./vectors/client-address.json', import.meta.url), 'utf8')) as {
  trusted: string[];
  vectors: Array<{peer: string | null; xff: string | null; key: string | null; why: string}>;
  rejected: string[];
  accepted: string[];
};
const hops = buildHops(spec.trusted);
const key = (peer: string | null, xff: string | null) => {
  const ip = resolveClientIp(peer, xff, hops);
  return ip ? bucketKey(ip) : null;
};

describe('D-12 · paridad con resolve_client_ip del Core', () => {
  for (const v of spec.vectors) {
    it(v.why + ` (${v.peer} | ${v.xff})`, () => expect(key(v.peer, v.xff)).toBe(v.key));
  }
  it('rotar el valor falsificado detrás de un worker no compra nada', () => {
    const keys = new Set(Array.from({length: 20}, (_, i) => key('185.125.168.236', `9.9.9.${i}, 2a06:98c0:3600::103, 162.158.90.12`)));
    expect(keys.size).toBe(1);
  });
});

describe('T-26 · parseo estricto de MCP_TRUSTED_PROXY_CIDRS', () => {
  for (const value of spec.rejected) it(`rechaza ${value}`, () => expect(() => parseTrustedProxyCidrs([value])).toThrow());
  for (const value of spec.accepted) it(`acepta ${value}`, () => expect(parseTrustedProxyCidrs([value])).toHaveLength(1));
  it('lee la forma JSON del compose del Core y la lista con comas', () => {
    expect(trustedCidrsFromEnv('["185.125.168.236/32"]')).toEqual(['185.125.168.236/32']);
    expect(trustedCidrsFromEnv('185.125.168.236/32, 2001:db8::/32')).toEqual(['185.125.168.236/32', '2001:db8::/32']);
    expect(trustedCidrsFromEnv(undefined)).toEqual([]);
  });
});
