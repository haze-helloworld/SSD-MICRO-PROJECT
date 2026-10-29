/** Classic token bucket: `burst` capacity, `refillPerSec` tokens per second. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private burst: number, private refillPerSec: number, private now: () => number = Date.now) {
    this.tokens = burst;
    this.last = now();
  }
  take(n = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}
