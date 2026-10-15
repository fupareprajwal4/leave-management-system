import mongoose from 'mongoose';
import { LeaveApplication, ApprovalAction, AuditLog, Department, LeaveType, User, EmailOutbox } from '../models/index.js';
import { recordConsumption } from './accounting.js';
import { HttpError } from '../utils/errors.js';

const allowed: Record<string, string[]> = {
  'hod:approve': ['Pending HOD', 'Returned by HOD'], 'hod:reject': ['Pending HOD', 'Returned by HOD'], 'hod:return': ['Pending HOD', 'Returned by HOD'],
  'admin:approve': ['Pending Admin', 'Returned by Admin'], 'admin:reject': ['Pending Admin', 'Returned by Admin'], 'admin:return': ['Pending Admin', 'Returned by Admin'],
};
export function isDecisionAllowed(role: 'hod'|'admin', action: 'approve'|'reject'|'return', status: string) {
  return Boolean(allowed[`${role}:${action}`]?.includes(status));
}
export function calculateCalendarDays(start: Date, end: Date) {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return 0;
  return Math.floor((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000) + 1;
}


export async function decide(input: { applicationId: string; actor: any; action: 'approve'|'reject'|'return'; remarks?: string; requestId?: string }) {
  const session = await mongoose.startSession(); let result: any;
  try {
    await session.withTransaction(async () => {
      const app = await LeaveApplication.findById(input.applicationId).session(session);
      if (!app) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
      const role = input.actor.role;
      if (role !== 'hod' && role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Only an authorized reviewer can process applications.');
      if (String(app.employeeId) === String(input.actor._id)) throw new HttpError(403, 'SELF_APPROVAL', 'You cannot process your own leave application.');
      if (role === 'hod') {
        const dept = await Department.findById(app.departmentId).session(session);
        if (!dept || String(dept.hodId) !== String(input.actor._id) || String(input.actor.departmentId) !== String(app.departmentId)) throw new HttpError(403, 'DEPARTMENT_SCOPE', 'HOD can only process requests in their assigned department.');
      }
      const key = `${role}:${input.action}`;
      if (!isDecisionAllowed(role as 'hod'|'admin', input.action, app.status)) throw new HttpError(409, 'INVALID_TRANSITION', `Action ${input.action} is not allowed from ${app.status}.`);
      const previous = app.status;
      if (input.action === 'approve' && role === 'hod' && app.workflow === 'both') app.status = 'Pending Admin';
      else if (input.action === 'approve') {
        const type = await LeaveType.findById(app.leaveTypeId).session(session);
        const startYear = new Date(app.startDate).getFullYear(); const endYear = new Date(app.endDate).getFullYear();
        if (startYear !== endYear) throw new HttpError(409, 'CROSS_YEAR_REVIEW', 'Cross-year leave requires policy-aware allocation before approval.');
        await recordConsumption({ employeeId: app.employeeId, leaveTypeId: app.leaveTypeId, year: startYear, days: app.requestedDays, applicationId: app._id, actorId: input.actor._id, reason: `Final approval ${app.reference}`, session });
        app.status = 'Approved'; app.finalDecision = { approvedBy: input.actor._id, approvedAt: new Date(), remarks: input.remarks || '', category: type?.name };
      } else if (input.action === 'reject') app.status = role === 'hod' ? 'Rejected by HOD' : 'Rejected by Admin';
      else app.status = role === 'hod' ? 'Returned by HOD' : 'Returned by Admin';
      app.version += 1;
      await app.save({ session });
      await ApprovalAction.create([{ applicationId: app._id, actorId: input.actor._id, actorRole: role, action: input.action === 'approve' && role === 'hod' && app.workflow === 'both' ? 'approve-forward' : input.action, remarks: input.remarks || '', previousStatus: previous, newStatus: app.status, workflowVersion: app.workflowVersion }], { session });
      await AuditLog.create([{ actorId: input.actor._id, action: `leave.${input.action}`, entityType: 'LeaveApplication', entityId: String(app._id), requestId: input.requestId, before: { status: previous }, after: { status: app.status }, metadata: { remarks: input.remarks || '' } }], { session });
      const employee = await User.findById(app.employeeId).session(session);
      if (employee?.email) await EmailOutbox.create([{ recipient: employee.email, eventType: `leave.${input.action}`, applicationId: app._id, payload: { subject: `Leave application ${app.reference}: ${app.status}`, text: `Your leave application ${app.reference} is now ${app.status}.${input.remarks ? ` Reviewer remarks: ${input.remarks}` : ''}` }, status: 'pending' }], { session });
      if (role === 'hod' && input.action === 'approve' && app.status === 'Pending Admin') { const admins = await User.find({ role: 'admin', active: true, provisioned: true }).select('email').session(session); const jobs = admins.filter((u:any)=>u.email).map((u:any)=>({recipient:u.email,eventType:'leave.forwarded-to-admin',applicationId:app._id,payload:{subject:`Leave request ${app.reference} needs establishment review`,text:`HOD approved ${app.reference}; it is awaiting establishment review. Sign in to the SGGSIE&T Leave Portal.`},status:'pending'})); if(jobs.length) await EmailOutbox.create(jobs,{session}); }
      result = app;
    });
  } finally { await session.endSession(); }
  return result;
}

export async function createApplication(input: any, actor: any, requestId?: string, idempotencyKey?: string) {
  const start = new Date(input.startDate); const end = new Date(input.endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) throw new HttpError(400, 'INVALID_DATES', 'End date must be on or after start date.');
  if (start.getFullYear() !== end.getFullYear()) throw new HttpError(400, 'CROSS_YEAR_REVIEW', 'Cross-year requests require configured allocation policy.');
  if (idempotencyKey) { const prior = await LeaveApplication.findOne({ employeeId: actor._id, idempotencyKey }); if (prior) return prior; }
  const dept = await Department.findById(actor.departmentId);
  if (!dept || !dept.hodId) throw new HttpError(409, 'HOD_UNASSIGNED', 'Your department must have an assigned HOD before applying.');
  const leaveType = await LeaveType.findById(input.leaveTypeId);
  if (!leaveType || !leaveType.active) throw new HttpError(400, 'INVALID_LEAVE_TYPE', 'Choose an active leave category.');
  const days = calculateCalendarDays(start, end);
  const overlap = await LeaveApplication.findOne({ employeeId: actor._id, status: { $in: ['Pending HOD','Returned by HOD','Pending Admin','Returned by Admin','Approved'] }, startDate: { $lte: end }, endDate: { $gte: start } });
  if (overlap) throw new HttpError(409, 'OVERLAPPING_APPLICATION', 'This date range overlaps an existing request.');
  const reference = `LV-${new Date().getFullYear()}-${new mongoose.Types.ObjectId().toString().slice(-6).toUpperCase()}`;
  const app = await LeaveApplication.create({ reference, employeeId: actor._id, departmentId: actor.departmentId, leaveTypeId: input.leaveTypeId, startDate: start, endDate: end, requestedDays: days, reason: input.reason, absenceAddress: input.absenceAddress, contactNumber: input.contactNumber, headquartersPermission: input.headquartersPermission || 'no', substituteDetails: input.substituteDetails, workflow: leaveType.workflow, policyVersion: leaveType.policyVersion, idempotencyKey, status: 'Draft' });
  await AuditLog.create({ actorId: actor._id, action: 'leave.created', entityType: 'LeaveApplication', entityId: String(app._id), requestId, after: { status: app.status, reference: app.reference } });
  return app;
}
