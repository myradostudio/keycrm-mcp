/**
 * Client-side request pacing, so the server does not walk into the limits the
 * API documents. It only knows about its own requests: other programs behind the
 * same IP address or key spend the same allowance, so the API can still answer 429.
 */

export interface RateWindow {
  /** At most this many requests… */
  readonly limit: number;
  /** …within any period of this length. */
  readonly perMs: number;
}

export class RateLimiter {
  /** Send times of the most recent requests, oldest first; some may lie in the near future. */
  private readonly slots: number[] = [];
  private readonly capacity: number;

  constructor(
    private readonly windows: readonly RateWindow[],
    private readonly now: () => number = Date.now,
  ) {
    this.capacity = Math.max(0, ...windows.map((window) => window.limit));
  }

  /**
   * Books the earliest moment at which one more request fits every window and
   * returns how long to wait for it. When that wait would exceed `maxWaitMs`
   * nothing is booked and `granted` is false.
   *
   * Booking is synchronous, so concurrent callers cannot be handed the same slot.
   */
  reserve(maxWaitMs: number): { readonly granted: boolean; readonly waitMs: number } {
    const now = this.now();
    let at = now;
    for (const { limit, perMs } of this.windows) {
      // The request that would become the (limit + 1)-th within one window.
      const blocker = this.slots[this.slots.length - limit];
      if (blocker !== undefined) at = Math.max(at, blocker + perMs);
    }

    const waitMs = at - now;
    if (waitMs > maxWaitMs) return { granted: false, waitMs };

    this.slots.push(at);
    if (this.slots.length > this.capacity) this.slots.shift();
    return { granted: true, waitMs };
  }
}
