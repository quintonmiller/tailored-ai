/**
 * Counting semaphore. acquire() returns a release callback. Awaiters are
 * served FIFO when a slot frees up.
 */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("Semaphore permits must be >= 1");
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) next();
  }

  get availablePermits(): number {
    return this.permits;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }
}

/**
 * A keyed semaphore — one Semaphore per key. Useful for "max N concurrent
 * runs of agent X" without pre-declaring all keys.
 */
export class KeyedSemaphore {
  private semas = new Map<string, Semaphore>();
  private capacityFor: (key: string) => number;

  constructor(capacityFor: (key: string) => number) {
    this.capacityFor = capacityFor;
  }

  async acquire(key: string): Promise<() => void> {
    let sema = this.semas.get(key);
    if (!sema) {
      sema = new Semaphore(this.capacityFor(key));
      this.semas.set(key, sema);
    }
    return sema.acquire();
  }
}
