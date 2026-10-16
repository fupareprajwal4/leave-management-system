
import mongoose, { type ClientSession } from 'mongoose';
import { AnnualLeaveBalance, LeaveTransaction } from '../models/index.js';
import { HttpError } from '../utils/errors.js';

export function calendarYear(
  date: Date,
  timezone = process.env.APPLICATION_TIMEZONE || 'Asia/Kolkata',
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'year')?.value);
}

export async function initializeBalance(input: {
  employeeId: any;
  leaveTypeId: any;
  year: number;
  entitlement: number;
  actorId?: any;
  policyVersion?: number;
  session?: ClientSession;
}) {
  if (
    !Number.isInteger(input.entitlement) ||
    input.entitlement < 0 ||
    input.entitlement > 366
  ) {
    throw new HttpError(
      400,
      'INVALID_ENTITLEMENT',
      'Entitlement must be a whole number between 0 and 366 days.',
    );
  }

  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2200) {
    throw new HttpError(
      400,
      'INVALID_YEAR',
      'Balance year must be between 2000 and 2200.',
    );
  }

  const key = `opening:${input.employeeId}:${input.leaveTypeId}:${input.year}`;

  const run = async (session?: ClientSession) => {
    const existing = await AnnualLeaveBalance.findOne({
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      year: input.year,
    }).session(session || null);

    if (existing) return existing;

    const [balance] = await AnnualLeaveBalance.create(
      [
        {
          employeeId: input.employeeId,
          leaveTypeId: input.leaveTypeId,
          year: input.year,
          openingBalance: input.entitlement,
          assignedEntitlement: input.entitlement,
          remainingBalance: input.entitlement,
          consumedDays: 0,
          reservedDays: 0,
          policyVersion: input.policyVersion || 1,
        },
      ],
      { session },
    );

    await LeaveTransaction.create(
      [
        {
          employeeId: input.employeeId,
          leaveTypeId: input.leaveTypeId,
          year: input.year,
          type: 'opening-credit',
          days: input.entitlement,
          balanceBefore: 0,
          balanceAfter: input.entitlement,
          reservedBefore: 0,
          reservedAfter: 0,
          actorId: input.actorId,
          reason: 'Individually assigned annual opening entitlement',
          idempotencyKey: key,
        },
      ],
      { session },
    );

    return balance;
  };

  if (input.session) return run(input.session);

  const session = await mongoose.startSession();
  let result: any;

  try {
    await session.withTransaction(async () => {
      result = await run(session);
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      const found = await AnnualLeaveBalance.findOne({
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
      });

      if (found) return found;
    }

    throw error;
  } finally {
    await session.endSession();
  }

  return result;
}

export async function reserveBalance(input: {
  employeeId: any;
  leaveTypeId: any;
  year: number;
  days: number;
  applicationId: any;
  actorId: any;
  reason: string;
  idempotencyKey: string;
  session: ClientSession;
}) {
  if (!Number.isInteger(input.days) || input.days <= 0) {
    throw new HttpError(
      400,
      'INVALID_DAYS',
      'Reserved days must be a positive whole number.',
    );
  }

  const prior = await LeaveTransaction.findOne({
    idempotencyKey: input.idempotencyKey,
  }).session(input.session);

  if (prior) return prior;

  const balance = await AnnualLeaveBalance.findOne({
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId,
    year: input.year,
    assignedEntitlement: { $exists: true },
  }).session(input.session);

  if (!balance) {
    throw new HttpError(
      409,
      'BALANCE_NOT_ASSIGNED',
      'An individual leave entitlement has not been assigned for this year. Contact the Establishment Section.',
    );
  }

  const updated = await AnnualLeaveBalance.findOneAndUpdate(
    {
      _id: balance._id,
      $expr: {
        $gte: [
          {
            $subtract: [
              '$remainingBalance',
              { $ifNull: ['$reservedDays', 0] },
            ],
          },
          input.days,
        ],
      },
    },
    { $inc: { reservedDays: input.days } },
    { new: true, session: input.session, runValidators: true },
  );

  if (!updated) {
    throw new HttpError(
      409,
      'INSUFFICIENT_BALANCE',
      'Available leave after existing reservations is insufficient.',
    );
  }

  const [transaction] = await LeaveTransaction.create(
    [
      {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        applicationId: input.applicationId,
        type: 'reservation',
        days: input.days,
        balanceBefore: balance.remainingBalance,
        balanceAfter: updated.remainingBalance,
        reservedBefore: balance.reservedDays,
        reservedAfter: updated.reservedDays,
        actorId: input.actorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    ],
    { session: input.session },
  );

  return transaction;
}

export async function releaseReservation(input: {
  employeeId: any;
  leaveTypeId: any;
  year: number;
  days: number;
  applicationId: any;
  actorId: any;
  reason: string;
  idempotencyKey: string;
  session: ClientSession;
}) {
  if (!Number.isInteger(input.days) || input.days <= 0) {
    throw new HttpError(
      400,
      'INVALID_DAYS',
      'Released days must be a positive whole number.',
    );
  }

  const prior = await LeaveTransaction.findOne({
    idempotencyKey: input.idempotencyKey,
  }).session(input.session);

  if (prior) return prior;

  const balance = await AnnualLeaveBalance.findOne({
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId,
    year: input.year,
  }).session(input.session);

  if (!balance) {
    throw new HttpError(
      409,
      'BALANCE_NOT_FOUND',
      'Cannot release a reservation because the balance record is missing.',
    );
  }

  const updated = await AnnualLeaveBalance.findOneAndUpdate(
    { _id: balance._id, reservedDays: { $gte: input.days } },
    { $inc: { reservedDays: -input.days } },
    { new: true, session: input.session, runValidators: true },
  );

  if (!updated) {
    throw new HttpError(
      409,
      'RESERVATION_MISMATCH',
      'The reservation ledger does not contain enough reserved days to release.',
    );
  }

  const [transaction] = await LeaveTransaction.create(
    [
      {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        applicationId: input.applicationId,
        type: 'reservation-release',
        days: input.days,
        balanceBefore: balance.remainingBalance,
        balanceAfter: updated.remainingBalance,
        reservedBefore: balance.reservedDays,
        reservedAfter: updated.reservedDays,
        actorId: input.actorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    ],
    { session: input.session },
  );

  return transaction;
}

export async function recordConsumption(input: {
  employeeId: any;
  leaveTypeId: any;
  year: number;
  days: number;
  applicationId: any;
  actorId: any;
  reason: string;
  reserved?: boolean;
  session: ClientSession;
}) {
  if (!Number.isInteger(input.days) || input.days <= 0) {
    throw new HttpError(
      400,
      'INVALID_DAYS',
      'Consumption days must be a positive whole number.',
    );
  }

  const key = `consume:${input.applicationId}:${input.year}`;

  const prior = await LeaveTransaction.findOne({
    idempotencyKey: key,
  }).session(input.session);

  if (prior) return prior;

  const before = await AnnualLeaveBalance.findOne({
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId,
    year: input.year,
    assignedEntitlement: { $exists: true },
  }).session(input.session);

  if (!before) {
    throw new HttpError(
      409,
      'BALANCE_NOT_ASSIGNED',
      'An individual leave entitlement has not been assigned for this year.',
    );
  }

  const filter: any = {
    _id: before._id,
    remainingBalance: { $gte: input.days },
  };

  const inc: Record<string, number> = {
    remainingBalance: -input.days,
    consumedDays: input.days,
  };

  if (input.reserved) {
    filter.reservedDays = { $gte: input.days };
    inc.reservedDays = -input.days;
  } else {
    // Legacy requests without a reservation may consume only unreserved days.
    filter.$expr = {
      $gte: [
        {
          $subtract: [
            '$remainingBalance',
            { $ifNull: ['$reservedDays', 0] },
          ],
        },
        input.days,
      ],
    };
  }

  const updated = await AnnualLeaveBalance.findOneAndUpdate(
    filter,
    { $inc: inc },
    {
      new: true,
      session: input.session,
      runValidators: true,
    },
  );

  if (!updated) {
    throw new HttpError(
      409,
      'INSUFFICIENT_BALANCE',
      'Insufficient unreserved leave balance.',
    );
  }

  const [transaction] = await LeaveTransaction.create(
    [
      {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        applicationId: input.applicationId,
        type: 'consumption-debit',
        days: input.days,
        balanceBefore: before.remainingBalance,
        balanceAfter: updated.remainingBalance,
        reservedBefore: before.reservedDays,
        reservedAfter: updated.reservedDays,
        actorId: input.actorId,
        reason: input.reason,
        idempotencyKey: key,
      },
    ],
    { session: input.session },
  );

  return transaction;
}

export async function adjustBalance(input: {
  employeeId: any;
  leaveTypeId: any;
  year: number;
  delta: number;
  actorId: any;
  reason: string;
  idempotencyKey: string;
  session: ClientSession;
}) {
  if (!input.reason?.trim()) {
    throw new HttpError(
      400,
      'REASON_REQUIRED',
      'A reason is required for balance adjustments.',
    );
  }

  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new HttpError(
      400,
      'INVALID_ADJUSTMENT',
      'Adjustment must be a non-zero whole number of days.',
    );
  }

  const existing = await LeaveTransaction.findOne({
    idempotencyKey: input.idempotencyKey,
  }).session(input.session);

  if (existing) return existing;

  const balance = await AnnualLeaveBalance.findOne({
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId,
    year: input.year,
  }).session(input.session);

  if (!balance) {
    throw new HttpError(404, 'BALANCE_NOT_FOUND', 'Annual balance not found.');
  }

  const adjustmentFilter: any = {
    _id: balance._id,
    remainingBalance: { $gte: Math.max(0, -input.delta) },
  };

  if (input.delta < 0) {
    adjustmentFilter.$expr = {
      $gte: [
        { $add: ['$remainingBalance', input.delta] },
        { $ifNull: ['$reservedDays', 0] },
      ],
    };
  }

  const updated = await AnnualLeaveBalance.findOneAndUpdate(
    adjustmentFilter,
    { $inc: { remainingBalance: input.delta, adjustments: input.delta } },
    { new: true, session: input.session, runValidators: true },
  );

  if (!updated) {
    throw new HttpError(
      409,
      'NEGATIVE_BALANCE',
      'Adjustment would make the balance negative.',
    );
  }

  const [transaction] = await LeaveTransaction.create(
    [
      {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        type: 'adjustment',
        days: input.delta,
        balanceBefore: balance.remainingBalance,
        balanceAfter: updated.remainingBalance,
        reservedBefore: balance.reservedDays,
        reservedAfter: updated.reservedDays,
        actorId: input.actorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    ],
    { session: input.session },
  );

  return transaction;
}
