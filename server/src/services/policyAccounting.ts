import { HttpError } from '../utils/errors.js';

export function calculateQuotaChange(input: {
  oldEntitlement: number;
  newEntitlement: number;
  remainingBalance: number;
  reservedDays: number;
}) {
  const values = [
    input.oldEntitlement,
    input.newEntitlement,
    input.remainingBalance,
    input.reservedDays,
  ];

  if (
    values.some((value) => !Number.isFinite(value)) ||
    !Number.isInteger(input.oldEntitlement) ||
    !Number.isInteger(input.newEntitlement) ||
    !Number.isInteger(input.remainingBalance) ||
    !Number.isInteger(input.reservedDays) ||
    input.oldEntitlement < 0 ||
    input.newEntitlement < 0 ||
    input.remainingBalance < 0 ||
    input.reservedDays < 0
  ) {
    throw new HttpError(
      400,
      'INVALID_POLICY_BALANCE',
      'Policy quotas and balance values must be non-negative whole days.',
    );
  }

  const delta = input.newEntitlement - input.oldEntitlement;
  const remainingAfter = input.remainingBalance + delta;

  if (
    remainingAfter < 0 ||
    remainingAfter < input.reservedDays
  ) {
    throw new HttpError(
      409,
      'POLICY_QUOTA_BELOW_USAGE',
      'The new quota would put at least one employee below their consumed or reserved leave. Reconcile that balance before retrying.',
    );
  }

  return {
    delta,
    remainingAfter,
  };
}