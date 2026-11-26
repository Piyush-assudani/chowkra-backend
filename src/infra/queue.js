// Bounded async background job queue + Circuit Breaker + exponential backoff.
// Prevents slow I/O, log flushes, or third-party checks from blocking gameplay turns.

export class CircuitBreaker {
  constructor({ failureThreshold = 5, resetMs = 30_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failures = 0;
    this.openedAt = 0;
  }

  canRun() {
    if (this.state === 'CLOSED') return true;
    if (Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}

export class AsyncJobQueue {
  constructor({ concurrency = 2, maxQueueSize = 500, onError = null } = {}) {
    this.concurrency = concurrency;
    this.maxQueueSize = maxQueueSize;
    this.onError = onError;
    this.queue = [];
    this.active = 0;
    this.completed = 0;
    this.failed = 0;
    this.breakers = new Map();
  }

  breakerFor(name) {
    if (!this.breakers.has(name)) this.breakers.set(name, new CircuitBreaker());
    return this.breakers.get(name);
  }

  enqueue(name, taskFn, { maxAttempts = 3, baseDelayMs = 150 } = {}) {
    if (this.queue.length >= this.maxQueueSize) return false;
    const breaker = this.breakerFor(name);
    if (!breaker.canRun()) return false;
    this.queue.push({ name, taskFn, attempt: 0, maxAttempts, baseDelayMs, breaker });
    this._pump();
    return true;
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(() => job.taskFn())
        .then(() => {
          job.breaker.onSuccess();
          this.completed += 1;
        })
        .catch((err) => {
          job.attempt += 1;
          if (job.attempt < job.maxAttempts) {
            const jitter = Math.floor(Math.random() * 80);
            const delay = job.baseDelayMs * Math.pow(2, job.attempt - 1) + jitter;
            const t = setTimeout(() => {
              this.queue.push(job);
              this._pump();
            }, delay);
            t.unref();
          } else {
            job.breaker.onFailure();
            this.failed += 1;
            this.onError?.(job.name, err);
          }
        })
        .finally(() => {
          this.active -= 1;
          this._pump();
        });
    }
  }

  stats() {
    return { queued: this.queue.length, active: this.active, completed: this.completed, failed: this.failed };
  }
}
