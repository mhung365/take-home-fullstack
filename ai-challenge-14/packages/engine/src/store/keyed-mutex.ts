export type Release = () => void;

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timed out waiting for lock ${key}`);
    this.name = 'LockTimeoutError';
  }
}

/** Exclusive lock per key, handed to waiters in FIFO order. */
export class KeyedMutex {
  /** A key is present while held; its value is the queue of waiters. */
  private readonly held = new Map<string, Array<() => void>>();

  tryAcquire(key: string): Release | null {
    if (this.held.has(key)) return null;
    this.held.set(key, []);
    return this.releaser(key);
  }

  acquire(key: string, timeoutMs: number): Promise<Release> {
    const release = this.tryAcquire(key);
    if (release) return Promise.resolve(release);

    const queue = this.held.get(key)!;
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser(key));
      };
      const timer = setTimeout(() => {
        queue.splice(queue.indexOf(grant), 1);
        reject(new LockTimeoutError(key));
      }, timeoutMs);
      queue.push(grant);
    });
  }

  private releaser(key: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.held.get(key)?.shift();
      // Ownership passes straight to the next waiter, so tryAcquire can't barge in.
      if (next) next();
      else this.held.delete(key);
    };
  }
}
