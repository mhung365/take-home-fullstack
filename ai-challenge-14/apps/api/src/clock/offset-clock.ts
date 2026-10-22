import type { Clock } from '@claims/engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** System time plus an offset that only grows. Lives in the process, so it resets on restart. */
export class OffsetClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advanceDays(days: number): void {
    this.offsetMs += days * MS_PER_DAY;
  }

  get offset(): number {
    return this.offsetMs;
  }
}
