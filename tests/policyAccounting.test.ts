import { describe, expect, it } from 'vitest';
import { calculateQuotaChange } from '../server/src/services/policyAccounting.js';

describe('current-year policy quota changes', () => {
  it('credits a quota increase without resetting consumed leave', () => {
    expect(
      calculateQuotaChange({
        oldEntitlement: 8,
        newEntitlement: 9,
        remainingBalance: 6,
        reservedDays: 1,
      }),
    ).toEqual({
      delta: 1,
      remainingAfter: 7,
    });
  });

  it('reduces remaining leave by the quota delta while preserving reservations', () => {
    expect(
      calculateQuotaChange({
        oldEntitlement: 8,
        newEntitlement: 7,
        remainingBalance: 6,
        reservedDays: 1,
      }),
    ).toEqual({
      delta: -1,
      remainingAfter: 5,
    });
  });

  it('rejects a quota reduction below reserved days', () => {
    expect(() =>
      calculateQuotaChange({
        oldEntitlement: 8,
        newEntitlement: 2,
        remainingBalance: 3,
        reservedDays: 3,
      }),
    ).toThrow(/reserved leave/);
  });

  it('rejects negative or fractional accounting values', () => {
    expect(() =>
      calculateQuotaChange({
        oldEntitlement: 8,
        newEntitlement: 8.5,
        remainingBalance: 8,
        reservedDays: 0,
      }),
    ).toThrow();

    expect(() =>
      calculateQuotaChange({
        oldEntitlement: 8,
        newEntitlement: 7,
        remainingBalance: -1,
        reservedDays: 0,
      }),
    ).toThrow();
  });
});