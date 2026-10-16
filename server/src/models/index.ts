import mongoose, { Schema } from 'mongoose';
import dns from 'node:dns';

dns.setServers(['8.8.8.8', '1.1.1.1']);

const options = {
  timestamps: true,
  versionKey: false,
} as const;

const userSchema = new Schema(
  {
    googleSub: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    name: {
      type: String,
      required: true,
    },
    designation: {
      type: String,
      default: '',
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    role: {
      type: String,
      enum: ['faculty', 'hod', 'admin'],
      default: 'faculty',
      index: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    provisioned: {
      type: Boolean,
      default: false,
    },
    workflowLock: {
      type: Number,
      default: 0,
    },
  },
  options,
);

const departmentSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    hodId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  options,
);

const leaveTypeSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    abbreviation: {
      type: String,
      required: true,
      unique: true,
    },
    description: String,
    annualEntitlement: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message:
          'Annual entitlement must be a whole number of days.',
      },
    },
    balancePolicy: {
      type: String,
      enum: ['shared', 'separate', 'none'],
      default: 'separate',
    },
    workflow: {
      type: String,
      enum: ['hod', 'both'],
      default: 'both',
    },
    template: {
      type: String,
      enum: ['letter', 'application', 'both'],
      default: 'both',
    },
    active: {
      type: Boolean,
      default: true,
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    policyVersion: {
      type: Number,
      default: 1,
    },
  },
  options,
);

const balanceSchema = new Schema(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    leaveTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    openingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedEntitlement: {
      type: Number,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message:
          'Assigned entitlement must be a whole number of days.',
      },
    },
    accrualCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
    consumedDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    reservedDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    adjustments: {
      type: Number,
      default: 0,
    },
    remainingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    policyVersion: {
      type: Number,
      default: 1,
    },
  },
  options,
);

balanceSchema.index(
  {
    employeeId: 1,
    leaveTypeId: 1,
    year: 1,
  },
  { unique: true },
);

const applicationSchema = new Schema(
  {
    reference: {
      type: String,
      unique: true,
      index: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
      index: true,
    },
    leaveTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
    },
    applicationDate: {
      type: Date,
      default: Date.now,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    requestedDays: {
      type: Number,
      required: true,
      min: 0.5,
    },
    reason: {
      type: String,
      required: true,
      minlength: 5,
      maxlength: 4000,
    },
    absenceAddress: String,
    contactNumber: String,
    headquartersPermission: {
      type: String,
      enum: ['yes', 'no', 'not-applicable'],
      default: 'no',
    },
    substituteDetails: String,
    attachments: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Attachment',
      },
    ],
    status: {
      type: String,
      enum: [
        'Draft',
        'Pending HOD',
        'Returned by HOD',
        'Pending Admin',
        'Returned by Admin',
        'Approved',
        'Rejected by HOD',
        'Rejected by Admin',
        'Withdrawn',
        'Cancelled',
      ],
      default: 'Draft',
      index: true,
    },
    workflow: {
      type: String,
      enum: ['hod', 'both'],
      default: 'both',
    },
    workflowVersion: {
      type: Number,
      default: 1,
    },
    policyVersion: {
      type: Number,
      default: 1,
    },
    submittedSnapshot: {
      type: Schema.Types.Mixed,
    },
    finalDecision: {
      type: Schema.Types.Mixed,
    },
    idempotencyKey: {
      type: String,
      index: true,
      sparse: true,
    },
    balanceReserved: {
      type: Boolean,
      default: false,
    },
    version: {
      type: Number,
      default: 1,
    },
  },
  options,
);

applicationSchema.index({
  employeeId: 1,
  startDate: 1,
  endDate: 1,
  status: 1,
});

applicationSchema.index(
  {
    employeeId: 1,
    idempotencyKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' },
    },
  },
);

const approvalSchema = new Schema(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveApplication',
      required: true,
      index: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorRole: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
    },
    remarks: {
      type: String,
      default: '',
    },
    previousStatus: String,
    newStatus: String,
    workflowVersion: Number,
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  { versionKey: false },
);

const transactionSchema = new Schema(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    leaveTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveApplication',
      default: null,
    },
    type: {
      type: String,
      enum: [
        'opening-credit',
        'accrual-credit',
        'consumption-debit',
        'reservation',
        'reservation-release',
        'reversal',
        'adjustment',
      ],
      required: true,
    },
    days: {
      type: Number,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    reservedBefore: Number,
    reservedAfter: Number,
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reason: {
      type: String,
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  { versionKey: false },
);

const attachmentSchema = new Schema(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveApplication',
      required: true,
    },
    originalFilename: String,
    storageKey: {
      type: String,
      required: true,
      unique: true,
    },
    contentType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    uploaderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    scanStatus: {
      type: String,
      enum: ['pending', 'clean', 'blocked'],
      default: 'pending',
    },
    accessPolicy: {
      type: String,
      default: 'application-participants',
    },
  },
  options,
);

const outboxSchema = new Schema(
  {
    recipient: {
      type: String,
      required: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveApplication',
    },
    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: [
        'pending',
        'sending',
        'accepted',
        'delivered',
        'failed',
      ],
      default: 'pending',
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    providerReference: String,
    lastError: String,
    nextAttemptAt: Date,
  },
  options,
);

const auditSchema = new Schema(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    action: {
      type: String,
      required: true,
    },
    entityType: {
      type: String,
      required: true,
    },
    entityId: {
      type: String,
      required: true,
    },
    requestId: String,
    before: {
      type: Schema.Types.Mixed,
    },
    after: {
      type: Schema.Types.Mixed,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  { versionKey: false },
);

auditSchema.index({
  entityType: 1,
  entityId: 1,
  createdAt: 1,
});

const policySchema = new Schema(
  {
    leaveTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
    },
    version: {
      type: Number,
      required: true,
    },
    annualEntitlement: {
      type: Number,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message:
          'Annual entitlement must be a whole number of days.',
      },
    },
    accountingPeriod: {
      type: String,
      default: 'calendar-year',
    },
    workingDayRule: {
      type: String,
      default: 'institution-configured',
    },
    carryForward: {
      type: Boolean,
      default: false,
    },
    effectiveFrom: {
      type: Date,
      required: true,
    },
    effectiveTo: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
  },
  options,
);

policySchema.index(
  {
    leaveTypeId: 1,
    version: 1,
  },
  { unique: true },
);

const facultyLeaveEntitlementSchema = new Schema(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    leaveTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
      index: true,
    },
    year: {
      type: Number,
      required: true,
      min: 2000,
      max: 2200,
    },
    days: {
      type: Number,
      required: true,
      min: 0,
      max: 366,
      validate: {
        validator: Number.isInteger,
        message:
          'Entitlement must be a whole number of days.',
      },
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    reason: {
      type: String,
      default:
        'Automatically granted from institutional policy.',
      maxlength: 500,
    },
    policyVersion: {
      type: Number,
      default: 1,
    },
  },
  options,
);

facultyLeaveEntitlementSchema.index(
  {
    employeeId: 1,
    leaveTypeId: 1,
    year: 1,
  },
  { unique: true },
);

const accessRequestSchema = new Schema(
  {
    googleSub: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: '',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  options,
);

accessRequestSchema.index({
  status: 1,
  createdAt: -1,
});

// Reuse registered models to avoid OverwriteModelError during reloads.
export const AccessRequest =
  mongoose.models.AccessRequest ||
  mongoose.model('AccessRequest', accessRequestSchema);

export const User =
  mongoose.models.User ||
  mongoose.model('User', userSchema);

export const Department =
  mongoose.models.Department ||
  mongoose.model('Department', departmentSchema);

export const LeaveType =
  mongoose.models.LeaveType ||
  mongoose.model('LeaveType', leaveTypeSchema);

export const AnnualLeaveBalance =
  mongoose.models.AnnualLeaveBalance ||
  mongoose.model('AnnualLeaveBalance', balanceSchema);

export const FacultyLeaveEntitlement =
  mongoose.models.FacultyLeaveEntitlement ||
  mongoose.model(
    'FacultyLeaveEntitlement',
    facultyLeaveEntitlementSchema,
  );

export const LeaveApplication =
  mongoose.models.LeaveApplication ||
  mongoose.model('LeaveApplication', applicationSchema);

export const ApprovalAction =
  mongoose.models.ApprovalAction ||
  mongoose.model('ApprovalAction', approvalSchema);

export const LeaveTransaction =
  mongoose.models.LeaveTransaction ||
  mongoose.model('LeaveTransaction', transactionSchema);

export const Attachment =
  mongoose.models.Attachment ||
  mongoose.model('Attachment', attachmentSchema);

export const EmailOutbox =
  mongoose.models.EmailOutbox ||
  mongoose.model('EmailOutbox', outboxSchema);

export const AuditLog =
  mongoose.models.AuditLog ||
  mongoose.model('AuditLog', auditSchema);

export const LeavePolicy =
  mongoose.models.LeavePolicy ||
  mongoose.model('LeavePolicy', policySchema);