import {Lru} from '../auth/lru.js';

/**
 * Fixed-window counters in a bounded LRU (D-13). Per resolved client IP
 * (30/min) and per sha256(ak‖sk) (120/min), checked BEFORE any exchange or
 * upstream call. There is deliberately no limit per `ak` alone: with the app JWT
 * cached the server exchanges an `ak` about once every 30 minutes, and such a
 * limit would let whoever holds a public `ak` lock its legitimate users out.
 */
export class WindowLimiter {
  private readonly windows: Lru<string, {start: number; count: number}>;

  constructor(private readonly limit: number, private readonly windowMs = 60_000, maxEntries = 10_000, private readonly now: () => number = Date.now) {
    this.windows = new Lru(maxEntries);
  }

  get size(): number {
    return this.windows.size;
  }

  /** Counts the hit and answers whether it is within the limit. */
  allow(key: string): boolean {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      this.windows.set(key, {start: now, count: 1});
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}
