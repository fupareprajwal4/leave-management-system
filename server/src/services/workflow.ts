
import mongoose from 'mongoose';
import {
  LeaveApplication,
  ApprovalAction,
  AuditLog,
  Department,
  LeaveType,
  User,
  EmailOutbox,
  FacultyLeaveEntitlement,
} from '../models/index.js';
import {
  calendarYear,
  recordConsumption,
  releaseReservation,
} from './accounting.js';
import { HttpError } from '../utils/errors.js';

const allowed: Record<string, string[]> = {
  'hod:approve': ['Pending HOD', 'Returned by HOD'],
  'hod:reject': ['Pending HOD', 'Returned by HOD'],
  'hod:return': ['Pending HOD', 'Returned by HOD'],
  'admin:approve': ['Pending Admin', 'Returned by Admin'],
  'admin:reject': ['Pending Admin', 'Returned by Admin'],
  'admin:return': ['Pending Admin', 'Returned by Admin'],
};

export function isDecisionAllowed(
  role: 'hod' | 'admin',
  action: 'approve' | 'reject' | 'return',
  status: string,
) {
  return Boolean(allowed[`${role}:${action}`]?.includes(status));
}

export function calculateCalendarDays(start: Date, end: Date) {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end < start
  ) {
    return 0;
  }

  // Use UTC date fields to make date-only calculations consistent across hosts.
  const startDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );

  return Math.floor((endDay - startDay) / 86400000) + 1;
}

export async function decide(input: {
  applicationId: string;
  actor: any;
  action: 'approve' | 'reject' | 'return';
  remarks?: string;
  requestId?: string;
}) {
  const session = await mongoose.startSession();
  let result: any;

  try {
    await session.withTransaction(async () => {
      const app = await LeaveApplication.findById(input.applicationId).session(
        session,
      );

      if (!app) {
        throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
      }

      const role = input.actor.role;

      if (role !== 'hod' && role !== 'admin') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only an authorized reviewer can process applications.',
        );
      }

      if (String(app.employeeId) === String(input.actor._id)) {
        throw new HttpError(
          403,
          'SELF_APPROVAL',
          'You cannot process your own leave application.',
        );
      }

      if (role === 'hod') {
        const department = await Department.findById(app.departmentId).session(
          session,
        );

        if (
          !department ||
          String(department.hodId) !== String(input.actor._id) ||
          String(input.actor.departmentId) !== String(app.departmentId)
        ) {
          throw new HttpError(
            403,
            'DEPARTMENT_SCOPE',
            'HOD can only process requests in their assigned department.',
          );
        }
      }

      if (!isDecisionAllowed(role, input.action, app.status)) {
        throw new HttpError(
          409,
          'INVALID_TRANSITION',
          `Action ${input.action} is not allowed from ${app.status}.`,
        );
      }

      const previous = app.status;
      const isForwarding =
        input.action === 'approve' &&
        role === 'hod' &&
        app.workflow === 'both';

      if (isForwarding) {
        app.status = 'Pending Admin';
      } else if (input.action === 'approve') {
        const leaveType = await LeaveType.findById(app.leaveTypeId).session(
          session,
        );

        if (!leaveType) {
          throw new HttpError(
            409,
            'LEAVE_TYPE_NOT_FOUND',
            'The leave category for this application no longer exists.',
          );
        }

        const year = calendarYear(new Date(app.startDate));
        const endYear = calendarYear(new Date(app.endDate));

        if (year !== endYear) {
          throw new HttpError(
            409,
            'CROSS_YEAR_REVIEW',
            'Cross-year leave requires an approved allocation policy before approval.',
          );
        }

        if (leaveType.balancePolicy === 'shared') {
          throw new HttpError(
            409,
            'UNSUPPORTED_BALANCE_POLICY',
            'Shared leave pools are not implemented. Configure separate individual balances.',
          );
        }

        if (leaveType.balancePolicy === 'separate') {
          const entitlement = await FacultyLeaveEntitlement.findOne({
            employeeId: app.employeeId,
            leaveTypeId: app.leaveTypeId,
            year,
          }).session(session);

          if (!entitlement) {
            throw new HttpError(
              409,
              'BALANCE_NOT_ASSIGNED',
              'This employee has no individual entitlement for the application year.',
            );
          }

          await recordConsumption({
            employeeId: app.employeeId,
            leaveTypeId: app.leaveTypeId,
            year,
            days: app.requestedDays,
            applicationId: app._id,
            actorId: input.actor._id,
            reason: `Final approval ${app.reference}`,
            reserved: Boolean(app.balanceReserved),
            session,
          });

          app.balanceReserved = false;
        } else if (app.balanceReserved) {
          // Do not strand a reservation if a category becomes a no-balance category.
          await releaseReservation({
            employeeId: app.employeeId,
            leaveTypeId: app.leaveTypeId,
            year,
            days: app.requestedDays,
            applicationId: app._id,
            actorId: input.actor._id,
            reason: `Reservation released because ${app.reference} is now a no-balance category`,
            idempotencyKey: `release:${app._id}:${app.version + 1}:${role}:no-balance`,
            session,
          });

          app.balanceReserved = false;
        }

        app.status = 'Approved';
        app.finalDecision = {
          approvedBy: input.actor._id,
          approvedAt: new Date(),
          remarks: input.remarks || '',
          category: leaveType.name,
        };
      } else {
        if (app.balanceReserved) {
          await releaseReservation({
            employeeId: app.employeeId,
            leaveTypeId: app.leaveTypeId,
            year: calendarYear(new Date(app.startDate)),
            days: app.requestedDays,
            applicationId: app._id,
            actorId: input.actor._id,
            reason: `Reservation released because ${app.reference} was ${
              input.action === 'reject' ? 'rejected' : 'returned'
            }`,
            idempotencyKey: `release:${app._id}:${app.version + 1}:${role}:${input.action}`,
            session,
          });

          app.balanceReserved = false;
        }

        app.status =
          input.action === 'reject'
            ? role === 'hod'
              ? 'Rejected by HOD'
              : 'Rejected by Admin'
            : role === 'hod'
              ? 'Returned by HOD'
              : 'Returned by Admin';
      }

      app.version += 1;
      await app.save({ session });

      await ApprovalAction.create(
        [
          {
            applicationId: app._id,
            actorId: input.actor._id,
            actorRole: role,
            action: isForwarding ? 'approve-forward' : input.action,
            remarks: input.remarks || '',
            previousStatus: previous,
            newStatus: app.status,
            workflowVersion: app.workflowVersion,
          },
        ],
        { session },
      );

      await AuditLog.create(
        [
          {
            actorId: input.actor._id,
            action: `leave.${input.action}`,
            entityType: 'LeaveApplication',
            entityId: String(app._id),
            requestId: input.requestId,
            before: { status: previous },
            after: { status: app.status },
            metadata: {
              remarks: input.remarks || '',
              balanceReserved: app.balanceReserved,
            },
          },
        ],
        { session },
      );

      const employee = await User.findById(app.employeeId).session(session);

      if (employee?.email) {
        await EmailOutbox.create(
          [
            {
              recipient: employee.email,
              eventType: `leave.${input.action}`,
              applicationId: app._id,
              payload: {
                subject: `Leave application ${app.reference}: ${app.status}`,
                text: `Your leave application ${app.reference} is now ${app.status}.${
                  input.remarks
                    ? ` Reviewer remarks: ${input.remarks}`
                    : ''
                }`,
              },
              status: 'pending',
            },
          ],
          { session },
        );
      }

      if (isForwarding) {
        const admins = await User.find({
          role: 'admin',
          active: true,
          provisioned: true,
        })
          .select('email')
          .session(session);

        const jobs = admins
          .filter((user: any) => user.email)
          .map((user: any) => ({
            recipient: user.email,
            eventType: 'leave.forwarded-to-admin',
            applicationId: app._id,
            payload: {
              subject: `Leave request ${app.reference} needs establishment review`,
              text: `HOD approved ${app.reference}; it is awaiting establishment review. Sign in to the SGGSIE&T Leave Portal.`,
            },
            status: 'pending',
          }));

        if (jobs.length) {
          await EmailOutbox.create(jobs, { session });
        }
      }

      result = app;
    });
  } finally {
    await session.endSession();
  }

  return result;
}

export async function createApplication(
  input: any,
  actor: any,
  requestId?: string,
  idempotencyKey?: string,
) {
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);

  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end < start
  ) {
    throw new HttpError(
      400,
      'INVALID_DATES',
      'End date must be on or after start date.',
    );
  }

  if (calendarYear(start) !== calendarYear(end)) {
    throw new HttpError(
      400,
      'CROSS_YEAR_REVIEW',
      'Cross-year requests require configured allocation policy.',
    );
  }

  const session = await mongoose.startSession();
  let result: any;

  try {
    await session.withTransaction(async () => {
      if (idempotencyKey) {
        const prior = await LeaveApplication.findOne({
          employeeId: actor._id,
          idempotencyKey,
        }).session(session);

        if (prior) {
          result = prior;
          return;
        }
      }

      const department = await Department.findById(
        actor.departmentId,
      ).session(session);

      if (!department || !department.hodId) {
        throw new HttpError(
          409,
          'HOD_UNASSIGNED',
          'Your department must have an assigned HOD before applying.',
        );
      }

      const leaveType = await LeaveType.findById(input.leaveTypeId).session(
        session,
      );

      if (!leaveType || !leaveType.active) {
        throw new HttpError(
          400,
          'INVALID_LEAVE_TYPE',
          'Choose an active leave category.',
        );
      }

      if (leaveType.balancePolicy === 'shared') {
        throw new HttpError(
          409,
          'UNSUPPORTED_BALANCE_POLICY',
          'Shared leave pools are not implemented. Configure separate individual balances.',
        );
      }

      const days = calculateCalendarDays(start, end);

      const overlap = await LeaveApplication.findOne({
        employeeId: actor._id,
        status: {
          $in: [
            'Pending HOD',
            'Returned by HOD',
            'Pending Admin',
            'Returned by Admin',
            'Approved',
          ],
        },
        startDate: { $lte: end },
        endDate: { $gte: start },
      }).session(session);

      if (overlap) {
        throw new HttpError(
          409,
          'OVERLAPPING_APPLICATION',
          'This date range overlaps an existing request.',
        );
      }

      const reference = `LV-${calendarYear(start)}-${new mongoose.Types.ObjectId()
        .toString()
        .slice(-6)
        .toUpperCase()}`;

      const [application] = await LeaveApplication.create(
        [
          {
            reference,
            employeeId: actor._id,
            departmentId: actor.departmentId,
            leaveTypeId: input.leaveTypeId,
            startDate: start,
            endDate: end,
            requestedDays: days,
            reason: input.reason,
            absenceAddress: input.absenceAddress,
            contactNumber: input.contactNumber,
            headquartersPermission: input.headquartersPermission || 'no',
            substituteDetails: input.substituteDetails,
            workflow: leaveType.workflow,
            policyVersion: leaveType.policyVersion,
            idempotencyKey,
            status: 'Draft',
            balanceReserved: false,
          },
        ],
        { session },
      );

      await AuditLog.create(
        [
          {
            actorId: actor._id,
            action: 'leave.created',
            entityType: 'LeaveApplication',
            entityId: String(application._id),
            requestId,
            after: {
              status: application.status,
              reference: application.reference,
            },
          },
        ],
        { session },
      );

      result = application;
    });
  } catch (error: any) {
    if (error?.code === 11000 && idempotencyKey) {
      const prior = await LeaveApplication.findOne({
        employeeId: actor._id,
        idempotencyKey,
      });

      if (prior) return prior;
    }

    throw error;
  } finally {
    await session.endSession();
  }

  return result;
}
