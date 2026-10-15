import mongoose, { type ClientSession } from 'mongoose';
import { AnnualLeaveBalance, LeaveTransaction } from '../models/index.js';
import { HttpError } from '../utils/errors.js';

export function calendarYear(date: Date, timezone = process.env.APPLICATION_TIMEZONE || 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric' }).formatToParts(date);
  return Number(parts.find(p => p.type === 'year')?.value);
}

export async function initializeBalance(input: { employeeId: any; leaveTypeId: any; year: number; entitlement: number; actorId?: any; policyVersion?: number; session?: ClientSession }) {
  if (!Number.isFinite(input.entitlement) || input.entitlement < 0) throw new HttpError(400, 'INVALID_ENTITLEMENT', 'Entitlement must be a non-negative number.');
  const key = `opening:${input.employeeId}:${input.leaveTypeId}:${input.year}`;
  const run = async (session?: ClientSession) => {
    const existing = await AnnualLeaveBalance.findOne({ employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year }).session(session || null);
    if (existing) return existing;
    const [balance] = await AnnualLeaveBalance.create([{
      employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year,
      openingBalance: input.entitlement, remainingBalance: input.entitlement, consumedDays: 0,
      reservedDays: 0, policyVersion: input.policyVersion || 1,
    }], { session });
    await LeaveTransaction.create([{
      employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year,
      type: 'opening-credit', days: input.entitlement, balanceBefore: 0, balanceAfter: input.entitlement,
      actorId: input.actorId, reason: 'Annual opening entitlement', idempotencyKey: key,
    }], { session });
    return balance;
  };
  if (input.session) return run(input.session);
  const session = await mongoose.startSession();
  let result: any;
  try { await session.withTransaction(async () => { result = await run(session); }); }
  catch (err: any) {
    if (err?.code === 11000) {
      const found = await AnnualLeaveBalance.findOne({ employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year });
      if (found) return found;
    }
    throw err;
  } finally { await session.endSession(); }
  return result;
}

export async function recordConsumption(input: { employeeId: any; leaveTypeId: any; year: number; days: number; applicationId: any; actorId: any; reason: string; session: ClientSession }) {
  if (!Number.isFinite(input.days) || input.days <= 0) throw new HttpError(400, 'INVALID_DAYS', 'Consumption days must be positive.');
  const key = `consume:${input.applicationId}:${input.year}`;
  const prior = await LeaveTransaction.findOne({ idempotencyKey: key }).session(input.session);
  if (prior) return prior;
  const before = await AnnualLeaveBalance.findOne({ employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year }).session(input.session);
  if (!before) throw new HttpError(409, 'BALANCE_NOT_INITIALIZED', 'Annual leave balance has not been initialized.');
  const updated = await AnnualLeaveBalance.findOneAndUpdate(
    { _id: before._id, remainingBalance: { $gte: input.days } },
    { $inc: { remainingBalance: -input.days, consumedDays: input.days } },
    { new: true, session: input.session, runValidators: true },
  );
  if (!updated) throw new HttpError(409, 'INSUFFICIENT_BALANCE', 'Insufficient leave balance.');
  const [transaction] = await LeaveTransaction.create([{
    employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year,
    applicationId: input.applicationId, type: 'consumption-debit', days: input.days,
    balanceBefore: before.remainingBalance, balanceAfter: updated.remainingBalance,
    actorId: input.actorId, reason: input.reason, idempotencyKey: key,
  }], { session: input.session });
  return transaction;
}

export async function adjustBalance(input: { employeeId: any; leaveTypeId: any; year: number; delta: number; actorId: any; reason: string; idempotencyKey: string; session: ClientSession }) {
  if (!input.reason?.trim()) throw new HttpError(400, 'REASON_REQUIRED', 'A reason is required for balance adjustments.');
  if (!Number.isFinite(input.delta) || input.delta === 0) throw new HttpError(400, 'INVALID_ADJUSTMENT', 'Adjustment must be a non-zero number.');
  const existing = await LeaveTransaction.findOne({ idempotencyKey: input.idempotencyKey }).session(input.session);
  if (existing) return existing;
  const balance = await AnnualLeaveBalance.findOne({ employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year }).session(input.session);
  if (!balance) throw new HttpError(404, 'BALANCE_NOT_FOUND', 'Annual balance not found.');
  const updated = await AnnualLeaveBalance.findOneAndUpdate({ _id: balance._id, remainingBalance: { $gte: Math.max(0, -input.delta) } }, { $inc: { remainingBalance: input.delta, adjustments: input.delta } }, { new: true, session: input.session });
  if (!updated) throw new HttpError(409, 'NEGATIVE_BALANCE', 'Adjustment would make the balance negative.');
  const [txn] = await LeaveTransaction.create([{ employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year, type: 'adjustment', days: input.delta, balanceBefore: balance.remainingBalance, balanceAfter: updated.remainingBalance, actorId: input.actorId, reason: input.reason, idempotencyKey: input.idempotencyKey }], { session: input.session });
  return txn;
}
