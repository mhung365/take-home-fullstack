export interface Clock {
  /** A new Date on every call; callers may mutate it. */
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface ClockAdvance {
  days?: number;
  hours?: number;
  minutes?: number;
  ms?: number;
}

/** Only moves when told to. Used by tests and by the API's demo mode (/dev/clock/advance). */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = toEpochMs(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = toEpochMs(at);
  }

  advance({ days = 0, hours = 0, minutes = 0, ms = 0 }: ClockAdvance): void {
    const delta = days * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + ms;
    if (!Number.isFinite(delta)) throw new Error('Clock advance must be a finite duration');
    this.current += delta;
  }
}

function toEpochMs(at: Date | string): number {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid date ${String(at)}`);
  return ms;
}
