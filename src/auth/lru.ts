/**
 * Bounded least-recently-used map. Every cache and counter keyed by something
 * the caller controls (an `ak`, an IP) goes through one of these: their
 * cardinality is the caller's to choose, so it must not be ours to store (D-8).
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('Lru max must be a positive integer');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}
