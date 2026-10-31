import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';

/**
 * The CLIENT's address behind the hosted chain (D-12): a port of the Core's
 * `app/core/client_address.py` (same walk, same safeguards, same vectors in
 * test/vectors/client-address.json).
 *
 *     client → Cloudflare → front door nginx (public IP) → this container
 *
 * The front door appends with `$proxy_add_x_forwarded_for`, so the header that
 * arrives is `[client-forged…,] <client per Cloudflare>, <Cloudflare edge>`.
 * Walk right to left: the peer must be one of OUR hops (private ranges plus
 * MCP_TRUSTED_PROXY_CIDRS) or the header is ignored; skip our hops; skip
 * EXACTLY ONE Cloudflare edge; the next entry is the client. Whatever the
 * client wrote further left is never reached.
 *
 * The result keys the MCP's own per-IP limit and is the single entry this
 * server writes, fresh, in X-Forwarded-For towards the API — which trusts this
 * container as a private hop and so counts one bucket per client.
 */

type Version = 4 | 6;
interface Net { version: Version; bits: bigint; prefix: number }
export interface Addr { version: Version; bits: bigint }

/**
 * A versioned CIDR list, one per line, `#` comments — byte-for-byte copies of
 * the Core's app/core/data/{private_proxy_hops,cloudflare_ips}.txt. A missing,
 * empty or unparseable file throws at import, i.e. the process does not start.
 */
export function loadCidrFile(name: string): string[] {
  const text = readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8');
  const entries = text.split('\n').map((line) => line.split('#', 1)[0]!.trim()).filter(Boolean);
  if (!entries.length) throw new Error(`${name} has no entries`);
  for (const entry of entries) parseNet(entry);
  return entries;
}

/** Shortest prefix accepted in MCP_TRUSTED_PROXY_CIDRS (mirror of the Core's MIN_TRUSTED_PREFIX). */
export const MIN_TRUSTED_PREFIX: Record<Version, number> = {4: 16, 6: 32};

const WIDTH: Record<Version, number> = {4: 32, 6: 128};

function v4Bits(s: string): bigint {
  return s.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function v6Bits(s: string): bigint {
  let text = s;
  let tail: bigint[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = v4Bits(text.slice(lastColon + 1));
    tail = [v4 >> 16n, v4 & 0xffffn];
    text = text.slice(0, lastColon + 1) + '0:0';
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right].map((g) => BigInt(Number.parseInt(g || '0', 16)));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

/** Parses an address the way the Core does: "v4:port", "[v6]:port", IPv4-mapped unwrapped. */
export function parseIp(value: string | null | undefined): Addr | undefined {
  if (!value) return undefined;
  let v = value.trim();
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']'));
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(':', 1)[0]!;
  const kind = isIP(v);
  if (kind === 4) return {version: 4, bits: v4Bits(v)};
  if (kind !== 6) return undefined;
  const bits = v6Bits(v);
  if (bits >> 32n === 0xffffn) return {version: 4, bits: bits & 0xffffffffn};
  return {version: 6, bits};
}

function parseNet(value: string): Net {
  const [address, prefixText] = value.trim().split('/');
  const ip = parseIp(address);
  if (!ip || (address ?? '').includes('[')) throw new Error(`not an IP network: ${JSON.stringify(value)}`);
  const width = WIDTH[ip.version];
  let prefix = width;
  if (prefixText !== undefined) prefix = /^\d+$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) throw new Error(`not an IP network: ${JSON.stringify(value)}`);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return {version: ip.version, bits: ip.bits & mask, prefix};
}

function inNet(ip: Addr, net: Net): boolean {
  if (ip.version !== net.version) return false;
  const width = WIDTH[net.version];
  const shift = BigInt(width - net.prefix);
  return net.prefix === 0 || ip.bits >> shift === net.bits >> shift;
}

const inAny = (ip: Addr, nets: readonly Net[]) => nets.some((n) => inNet(ip, n));

/** Always ours: private ranges (see the data file for why not `isPrivate`). */
export const PRIVATE_HOPS = loadCidrFile('private_proxy_hops.txt');

/** Cloudflare's published edges, trusted as ONE intermediate hop. */
export const CLOUDFLARE_RANGES = loadCidrFile('cloudflare_ips.txt');

/**
 * Strict parse of MCP_TRUSTED_PROXY_CIDRS: an invalid entry, or one broader than
 * /16 (IPv4) or /32 (IPv6), THROWS — called at startup so a typo stops the
 * process instead of trusting forged headers from most of the internet.
 */
export function parseTrustedProxyCidrs(values: readonly string[]): Net[] {
  return values.map((value) => {
    const net = parseNet(value);
    if (net.prefix < MIN_TRUSTED_PREFIX[net.version]) {
      throw new Error(`MCP_TRUSTED_PROXY_CIDRS: ${JSON.stringify(value)} is broader than /${MIN_TRUSTED_PREFIX[net.version]}`);
    }
    return net;
  });
}

/** Comma- or JSON-list env value (the Core's compose writes `["185.125.168.236/32"]`). */
export function trustedCidrsFromEnv(raw: string | undefined): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('MCP_TRUSTED_PROXY_CIDRS must be a list');
    return parsed.map(String);
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface Hops { ours: Net[]; cloudflare: Net[] }

export function buildHops(trusted: readonly string[]): Hops {
  return {
    ours: [...PRIVATE_HOPS.map(parseNet), ...parseTrustedProxyCidrs(trusted)],
    cloudflare: CLOUDFLARE_RANGES.map(parseNet),
  };
}

export function resolveClientIp(peer: string | null | undefined, forwardedFor: string | null | undefined, hops: Hops): Addr | undefined {
  const peerIp = parseIp(peer);
  if (!peerIp || !inAny(peerIp, hops.ours)) return peerIp;
  const entries = (forwardedFor ?? '').split(',');
  let last = peerIp;
  let i = entries.length - 1;
  while (i >= 0) {
    const hop = parseIp(entries[i]);
    if (!hop || !inAny(hop, hops.ours)) break;
    last = hop;
    i -= 1;
  }
  if (i < 0) return last;
  const hop = parseIp(entries[i]);
  if (!hop) return last;
  if (inAny(hop, hops.cloudflare)) {
    if (i === 0) return hop;
    return parseIp(entries[i - 1]) ?? hop;
  }
  return hop;
}

/** Canonical text of an address (IPv6 compressed like Python's `ipaddress`). */
export function formatIp(ip: Addr): string {
  if (ip.version === 4) return [24n, 16n, 8n, 0n].map((s) => String((ip.bits >> s) & 0xffn)).join('.');
  const groups = Array.from({length: 8}, (_, k) => Number((ip.bits >> BigInt(112 - 16 * k)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let k = 0; k < 8; ) {
    if (groups[k] !== 0) { k += 1; continue; }
    let j = k;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - k > bestLen && j - k >= 2) { bestStart = k; bestLen = j - k; }
    k = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

/** Bucket key: IPv4 → the address; IPv6 → its /64 (one subscriber holds a whole /64). */
export function bucketKey(ip: Addr): string {
  if (ip.version === 4) return formatIp(ip);
  const mask = ((1n << 64n) - 1n) << 64n;
  return `${formatIp({version: 6, bits: ip.bits & mask})}/64`;
}
