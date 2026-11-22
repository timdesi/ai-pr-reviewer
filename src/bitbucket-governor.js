// Process-wide request governor for every Bitbucket HTTP request.
//
// BitbucketClient instances are constructed fresh per dashboard poll, per
// review and per one-off fetch, so throttle/breaker state must NOT live on the
// client: it lives in the `bitbucketGovernor` singleton exported below. One
// import point makes that process-wide sharing explicit and lets tests inject
// a fake clock/sleep instead of depending on real timers.
//
// All values are internal constants — there is deliberately no config/env
// surface for pacing, spacing, breaker or Retry-After behaviour.

export const MIN_SPACING_MS = 200;
export const BREAKER_BASE_MS = 2_000;
export const BREAKER_MAX_MS = 30_000;
export const RETRY_AFTER_CAP_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Retry-After header into milliseconds, clamped to
 * [0, RETRY_AFTER_CAP_MS]. A numeric value is seconds; otherwise it is an
 * HTTP-date (Date.parse minus `nowMs`). Absent/invalid/NaN values → null.
 * A past date clamps to 0, which callers treat as "no explicit wait".
 */
export function parseRetryAfterHeader(value, nowMs = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  let ms;
  if (Number.isFinite(numeric)) {
    ms = numeric * 1000; // seconds -> milliseconds
  } else {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    ms = parsed - nowMs;
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
}

export class RequestGovernor {
  constructor({
    now = Date.now,
    sleep = defaultSleep,
    minSpacingMs = MIN_SPACING_MS,
    breakerBaseMs = BREAKER_BASE_MS,
    breakerMaxMs = BREAKER_MAX_MS,
    retryAfterCapMs = RETRY_AFTER_CAP_MS,
  } = {}) {
    this.now = now;
    this.sleep = sleep;
    this.minSpacingMs = minSpacingMs;
    this.breakerBaseMs = breakerBaseMs;
    this.breakerMaxMs = breakerMaxMs;
    this.retryAfterCapMs = retryAfterCapMs;
    this.pauseUntil = 0;
    this.streak = 0;
    // -Infinity lets the very first request proceed immediately even with a
    // fake clock that starts at 0; real Date.now() would make 0 irrelevant.
    this.lastStart = -Infinity;
    // All callers serialize through one promise tail. The tail is always
    // resolved (see finally in acquire) so a rejected waiter cannot poison it.
    this._tail = Promise.resolve();
  }

  /**
   * Resolve when exactly one caller may issue one HTTP request. Paces callers
   * at least minSpacingMs apart and holds everyone until pauseUntil. Re-checks
   * the wait after every sleep so a 429 that lands mid-wait extends callers
   * that were already queued. Never performs a fetch itself.
   */
  async acquire() {
    const predecessor = this._tail;
    let release;
    this._tail = new Promise((resolve) => {
      release = resolve;
    });
    await predecessor.catch(() => {});
    try {
      for (;;) {
        const now = this.now();
        const waitMs = Math.max(this.pauseUntil - now, this.lastStart + this.minSpacingMs - now, 0);
        if (waitMs > 0) {
          await this.sleep(waitMs);
          continue; // recompute: a 429 may have extended pauseUntil meanwhile
        }
        this.lastStart = this.now();
        return;
      }
    } finally {
      release();
    }
  }

  /** Open/extend the process-wide breaker for a 429. */
  noteRateLimited(retryAfterMs = null) {
    this.streak += 1;
    const backoffMs = Math.min(this.breakerBaseMs * 2 ** (this.streak - 1), this.breakerMaxMs);
    const pauseMs = retryAfterMs > 0 ? retryAfterMs : backoffMs;
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + pauseMs);
  }

  /** A 2xx closes the 429 streak; it does not shorten an already-open window. */
  noteSuccess() {
    this.streak = 0;
  }

  getState() {
    return { pauseUntil: this.pauseUntil, streak: this.streak, lastStart: this.lastStart };
  }
}

export const bitbucketGovernor = new RequestGovernor();
