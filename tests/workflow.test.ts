
import { describe, it, expect } from 'vitest';
import {
  calculateCalendarDays,
  isDecisionAllowed,
} from '../server/src/services/workflow.js';

describe('calendar-day calculation', () => {
  it('counts both endpoints inclusively', () =>
    expect(
      calculateCalendarDays(
        new Date('2026-10-13T00:00:00Z'),
        new Date('2026-10-15T00:00:00Z'),
      ),
    ).toBe(3));

  it('handles leap day', () =>
    expect(
      calculateCalendarDays(
        new Date('2028-02-28T00:00:00Z'),
        new Date('2028-03-01T00:00:00Z'),
      ),
    ).toBe(3));

  it('treats date-only UTC values consistently across local timezones', () =>
    expect(
      calculateCalendarDays(
        new Date('2026-10-15T00:00:00.000Z'),
        new Date('2026-10-16T00:00:00.000Z'),
      ),
    ).toBe(2));

  it('rejects invalid or reversed ranges', () => {
    expect(calculateCalendarDays(new Date('invalid'), new Date())).toBe(0);
    expect(
      calculateCalendarDays(
        new Date('2026-10-15'),
        new Date('2026-10-13'),
      ),
    ).toBe(0);
  });
});

describe('approval state machine', () => {
  it('allows HOD to approve a pending HOD request', () =>
    expect(isDecisionAllowed('hod', 'approve', 'Pending HOD')).toBe(true));

  it('does not allow admin to act before HOD forwards', () =>
    expect(isDecisionAllowed('admin', 'approve', 'Pending HOD')).toBe(false));

  it('does not allow repeat decisions on final records', () =>
    expect(isDecisionAllowed('hod', 'approve', 'Approved')).toBe(false));

  it('allows admin only in the admin stage', () =>
    expect(isDecisionAllowed('admin', 'reject', 'Pending Admin')).toBe(true));
});
