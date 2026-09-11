/**
 * Bounds how many operations run at once across unrelated call sites.
 *
 * `pool` limits one batch; this limits a shared resource, so nested batches
 * cannot multiply past the configured ceiling.
 */
export class Semaphore {
  #limit: number;
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Semaphore.#sanitize(limit);
  }

  static #sanitize(limit: number): number {
    return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  }

  get limit(): number {
    return this.#limit;
  }

  /** Raising the limit releases waiters immediately; lowering it applies as permits are returned. */
  setLimit(limit: number): void {
    this.#limit = Semaphore.#sanitize(limit);
    this.#drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#drain();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#active++;
        resolve();
      });
    });
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#queue.length > 0) {
      (this.#queue.shift() as () => void)();
    }
  }
}
