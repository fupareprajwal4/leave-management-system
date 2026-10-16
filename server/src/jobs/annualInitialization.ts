
/**
 * Initializes only individually assigned entitlements for the requested year.
 * It deliberately does not grant every employee the LeaveType annual default.
 * Schedule with the hosting platform for January 1 in Asia/Kolkata.
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import {
  AnnualLeaveBalance,
  AuditLog,
  FacultyLeaveEntitlement,
  LeaveType,
  User,
} from '../models/index.js';
import { calendarYear, initializeBalance } from '../services/accounting.js';

export async function initializeAnnualBalances(
  year = calendarYear(new Date(), env.APPLICATION_TIMEZONE),
  actorId?: string,
) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error('Year must be an integer between 2000 and 2200.');
  }

  const assignments = await FacultyLeaveEntitlement.find({ year }).lean();
  let created = 0;
  let skipped = 0;

  for (const assignment of assignments) {
    const [employee, leaveType]: [any, any] = await Promise.all([
      User.findOne({
        _id: assignment.employeeId,
        active: true,
        provisioned: true,
        role: { $in: ['faculty', 'hod'] },
      }).lean(),
      LeaveType.findOne({
        _id: assignment.leaveTypeId,
        active: true,
      }).lean(),
    ]);

    if (
      !employee ||
      !leaveType ||
      leaveType.balancePolicy === 'none' ||
      leaveType.balancePolicy === 'shared'
    ) {
      skipped++;
      continue;
    }

    const before: any = await AnnualLeaveBalance.findOne({
      employeeId: assignment.employeeId,
      leaveTypeId: assignment.leaveTypeId,
      year,
    });

    if (before) {
      if (
        before.assignedEntitlement === undefined ||
        before.assignedEntitlement === null ||
        before.assignedEntitlement !== assignment.days
      ) {
        // Existing legacy balances must be reconciled by the explicit admin assignment flow.
        skipped++;
      }
      continue;
    }

    await initializeBalance({
      employeeId: assignment.employeeId,
      leaveTypeId: assignment.leaveTypeId,
      year,
      entitlement: assignment.days,
      actorId: actorId || assignment.assignedBy,
      policyVersion: assignment.policyVersion || leaveType.policyVersion,
    });

    created++;
  }

  await AuditLog.create({
    actorId: actorId || null,
    action: 'balance.annual-initialization',
    entityType: 'AnnualLeaveBalance',
    entityId: String(year),
    metadata: {
      year,
      created,
      assignedEntitlements: assignments.length,
      skipped,
    },
  });

  return {
    year,
    created,
    assignedEntitlements: assignments.length,
    skipped,
  };
}

if (
  process.argv[1]?.endsWith('annualInitialization.js') ||
  process.argv[1]?.endsWith('annualInitialization.ts')
) {
  await mongoose.connect(env.MONGODB_URI);

  try {
    console.log(await initializeAnnualBalances());
  } finally {
    await mongoose.disconnect();
  }
}
