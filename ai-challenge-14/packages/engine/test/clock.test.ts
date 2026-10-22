import { describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from '../src/clock';

describe('FakeClock', () => {
  it('stays put until set or advanced', () => {
    const clock = new FakeClock('2026-03-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');

    clock.advance({ days: 30, hours: 1, minutes: 2, ms: 3 });
    expect(clock.now().toISOString()).toBe('2026-03-31T01:02:00.003Z');

    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns a new Date each time, so mutating it does not move the clock', () => {
    const clock = new FakeClock('2026-03-01T00:00:00.000Z');
    clock.now().setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('rejects invalid dates and durations', () => {
    expect(() => new FakeClock('not a date')).toThrow('Invalid date not a date');
    expect(() => new FakeClock().advance({ days: Number.NaN })).toThrow('finite');
  });
});

describe('systemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
