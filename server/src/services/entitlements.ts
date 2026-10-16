import mongoose, { type ClientSession } from 'mongoose';
import {
  AnnualLeaveBalance,
  AuditLog,
  FacultyLeaveEntitlement,
  LeaveType,
  LeavePolicy,
  User,
} from '../models/index.js';
import { initializeBalance, calendarYear } from './accounting.js';
import { HttpError } from '../utils/errors.js';

/** Resolve an entitlement while preserving a legacy balance's original grant. */
export function resolveAutomaticEntitlement(
  policyDays: number,
  existingBalance?: {
    assignedEntitlement?: number | null;
    openingBalance?: number | null;
  } | null,
) {
  const days = existingBalance
    ? Number(
        existingBalance.assignedEntitlement ??
          existingBalance.openingBalance ??
          policyDays ??
          0,
      )
    : Number(policyDays ?? 0);

  if (
    !Number.isInteger(days) ||
    days < 0 ||
    days > 366
  ) {
    throw new HttpError(
      409,
      'INVALID_POLICY_ENTITLEMENT',
      'Entitlement must be a whole number from 0 to 366 days.',
    );
  }

  return days;
}

/**
 * Automatically provisions an eligible faculty member's individual
 * entitlement and annual balance from the active institutional policy.
 *
 * No individual administrator approval is required for routine allocation.
 * Existing balance records are not overwritten.
 */
export async function ensureEmployeeYearBalances(
  employeeId: string | mongoose.Types.ObjectId,
  year = calendarYear(new Date()),
  actorId?: string | mongoose.Types.ObjectId | null,
) {
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2200
  ) {
    throw new HttpError(
      400,
      'INVALID_YEAR',
      'Year must be between 2000 and 2200.',
    );
  }

  const user: any = await User.findOne({
    _id: employeeId,
    active: true,
    provisioned: true,
    role: { $in: ['faculty', 'hod'] },
  }).lean();

  if (!user) {
    return {
      employeeId: String(employeeId),
      year,
      created: 0,
      entitlementsCreated: 0,
      skipped: 0,
    };
  }

  const leaveTypes = await LeaveType.find({
    active: true,
    balancePolicy: 'separate',
  })
    .sort({ name: 1 })
    .lean();

  if (leaveTypes.length === 0) {
    return {
      employeeId: String(user._id),
      year,
      created: 0,
      entitlementsCreated: 0,
      skipped: 0,
    };
  }

  // Avoid opening a transaction for a routine login when every active
  // category has already been initialized for this employee and year.
  const [existingBalances, existingEntitlements] =
    await Promise.all([
      AnnualLeaveBalance.find({
        employeeId: user._id,
        year,
      })
        .select('leaveTypeId assignedEntitlement')
        .lean(),
      FacultyLeaveEntitlement.find({
        employeeId: user._id,
        year,
      })
        .select('leaveTypeId')
        .lean(),
    ]);

  const balanceByType = new Map<string, any>(
    existingBalances.map((row: any) => [
      String(row.leaveTypeId),
      row,
    ]),
  );

  const entitlementTypes = new Set(
    existingEntitlements.map((row: any) =>
      String(row.leaveTypeId),
    ),
  );

  if (
    leaveTypes.every((type: any) => {
      const balance = balanceByType.get(String(type._id));

      return Boolean(
        balance &&
          balance.assignedEntitlement !== undefined &&
          balance.assignedEntitlement !== null &&
          entitlementTypes.has(String(type._id)),
      );
    })
  ) {
    return {
      employeeId: String(user._id),
      year,
      created: 0,
      entitlementsCreated: 0,
      skipped: 0,
    };
  }

  let created = 0;
  let entitlementsCreated = 0;
  let skipped = 0;

  // Keep transactions bounded per employee. The database must support
  // transactions (for example, MongoDB Atlas or a replica set).
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      let entitlementsCreatedThisAttempt = 0;
      let balancesCreatedThisAttempt = 0;
      let skippedThisAttempt = 0;

      for (const type of leaveTypes) {
        let balance = await AnnualLeaveBalance.findOne({
          employeeId: user._id,
          leaveTypeId: type._id,
          year,
        }).session(session);

        let entitlement =
          await FacultyLeaveEntitlement.findOne({
            employeeId: user._id,
            leaveTypeId: type._id,
            year,
          }).session(session);

        if (!entitlement) {
          // Preserve existing grants for legacy balances. Only a genuinely
          // new balance uses the policy effective on the provisioning date.
          const policyAsOf = new Date();

          const applicablePolicy = balance
            ? null
            : await LeavePolicy.findOne({
                leaveTypeId: type._id,
                effectiveFrom: { $lte: policyAsOf },
                $or: [
                  { effectiveTo: { $exists: false } },
                  { effectiveTo: null },
                  { effectiveTo: { $gte: policyAsOf } },
                ],
              })
                .sort({
                  effectiveFrom: -1,
                  version: -1,
                })
                .session(session);

          const policyDays = Number(
            applicablePolicy?.annualEntitlement ??
              type.annualEntitlement ??
              0,
          );

          const days = resolveAutomaticEntitlement(
            policyDays,
            balance
              ? {
                  assignedEntitlement:
                    balance.assignedEntitlement,
                  openingBalance: balance.openingBalance,
                }
              : null,
          );

          const policyVersion = balance
            ? Number(
                balance.policyVersion ||
                  type.policyVersion ||
                  1,
              )
            : Number(
                applicablePolicy?.version ||
                  type.policyVersion ||
                  1,
              );

          [entitlement] =
            await FacultyLeaveEntitlement.create(
              [
                {
                  employeeId: user._id,
                  leaveTypeId: type._id,
                  year,
                  days,
                  assignedBy: actorId || null,
                  assignedAt: new Date(),
                  reason: balance
                    ? 'Automatically reconciled from the existing opening balance; history preserved.'
                    : 'Automatically granted from the institutional leave policy.',
                  policyVersion,
                },
              ],
              { session },
            );

          entitlementsCreatedThisAttempt++;

          await AuditLog.create(
            [
              {
                actorId: actorId || null,
                action: balance
                  ? 'balance.legacy-auto-reconciled'
                  : 'balance.entitlement-auto-granted',
                entityType: 'FacultyLeaveEntitlement',
                entityId: String(entitlement._id),
                metadata: {
                  employeeId: String(user._id),
                  leaveTypeId: String(type._id),
                  year,
                  days,
                  policyVersion,
                },
              },
            ],
            { session },
          );
        }

        if (!balance) {
          balance = await initializeBalance({
            employeeId: user._id,
            leaveTypeId: type._id,
            year,
            entitlement: entitlement.days,
            actorId: actorId || null,
            policyVersion:
              entitlement.policyVersion ||
              type.policyVersion ||
              1,
            session,
          });

          balancesCreatedThisAttempt++;
        } else if (
          balance.assignedEntitlement === undefined ||
          balance.assignedEntitlement === null
        ) {
          // Add missing entitlement metadata without resetting the existing
          // opening balance, remaining balance, consumption or reservations.
          balance.assignedEntitlement = entitlement.days;
          balance.policyVersion =
            entitlement.policyVersion ||
            type.policyVersion ||
            1;

          await balance.save({ session });
        }

        if (
          balance &&
          entitlement &&
          balance.assignedEntitlement !== entitlement.days
        ) {
          // Do not silently rewrite an existing grant here. A deliberate
          // current-year policy change must use the policy-update workflow.
          skippedThisAttempt++;
        }
      }

      created = balancesCreatedThisAttempt;
      entitlementsCreated = entitlementsCreatedThisAttempt;
      skipped = skippedThisAttempt;
    });
  } catch (error: any) {
    if (error?.code === 11000 || error?.code === 112) {
      // A concurrent login or scheduled initializer may have created the
      // same unique record first. The next run observes the committed data.
      return {
        employeeId: String(user._id),
        year,
        created: 0,
        entitlementsCreated: 0,
        skipped: leaveTypes.length,
      };
    }

    throw error;
  } finally {
    await session.endSession();
  }

  return {
    employeeId: String(user._id),
    year,
    created,
    entitlementsCreated,
    skipped,
  };
}

export async function ensureCurrentYearBalances(
  employeeId: string | mongoose.Types.ObjectId,
) {
  return ensureEmployeeYearBalances(
    employeeId,
    calendarYear(new Date()),
  );
}

/** Scheduled bulk initializer with bounded concurrency for 1,000+ users. */
export async function ensureAllFacultyYearBalances(
  year: number,
  actorId?: string,
) {
  const users = await User.find({
    active: true,
    provisioned: true,
    role: { $in: ['faculty', 'hod'] },
  })
    .select('_id')
    .lean();

  let created = 0;
  let entitlementsCreated = 0;
  let skipped = 0;

  for (
    let offset = 0;
    offset < users.length;
    offset += 10
  ) {
    const batch = users.slice(offset, offset + 10);

    const results = await Promise.all(
      batch.map((user: any) =>
        ensureEmployeeYearBalances(
          user._id,
          year,
          actorId,
        ),
      ),
    );

    for (const result of results) {
      created += result.created;
      entitlementsCreated += result.entitlementsCreated;
      skipped += result.skipped;
    }
  }

  await AuditLog.create({
    actorId: actorId || null,
    action: 'balance.annual-initialization',
    entityType: 'AnnualLeaveBalance',
    entityId: String(year),
    metadata: {
      year,
      facultyProcessed: users.length,
      balancesCreated: created,
      entitlementsCreated,
      skipped,
    },
  });

  return {
    year,
    facultyProcessed: users.length,
    balancesCreated: created,
    entitlementsCreated,
    skipped,
  };
}