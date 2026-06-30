import type { RateLimitStore } from './types';

interface WindowEntry {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, WindowEntry>();

  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      const newEntry: WindowEntry = { count: 1, resetAt: now + windowMs };
      this.store.set(key, newEntry);
      return { count: 1, resetAt: newEntry.resetAt };
    }

    entry.count++;
    return { count: entry.count, resetAt: entry.resetAt };
  }
}
