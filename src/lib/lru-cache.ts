export class LruCache<K, V> {
  private maxSize: number;
  private readonly items: Map<K, V>;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, Math.floor(maxSize));
    this.items = new Map();
  }

  get size() {
    return this.items.size;
  }

  get(key: K) {
    const value = this.items.get(key);
    if (value === undefined && !this.items.has(key)) return undefined;

    this.items.delete(key);
    this.items.set(key, value as V);
    return value;
  }

  set(key: K, value: V) {
    if (this.items.has(key)) {
      this.items.delete(key);
    }

    this.items.set(key, value);

    while (this.items.size > this.maxSize) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.items.delete(oldestKey);
    }

    return this;
  }

  resize(maxSize: number) {
    this.maxSize = Math.max(1, Math.floor(maxSize));

    while (this.items.size > this.maxSize) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.items.delete(oldestKey);
    }

    return this;
  }

  clear() {
    this.items.clear();
  }
}
