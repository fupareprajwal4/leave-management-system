import { Router } from "express";
import PDFDocument from "pdfkit";
import mongoose from "mongoose";
import { z } from "zod";
import { DEPARTMENTS } from "../config/departments.js";
import {
  AccessRequest,
  Department,
  User,
  LeaveType,
  LeaveApplication,
  AnnualLeaveBalance,
  FacultyLeaveEntitlement,
  ApprovalAction,
  AuditLog,
  LeavePolicy,
  LeaveTransaction,
  EmailOutbox,
} from "../models/index.js";
import {
  requireAuth,
  requireRole,
  requireAssignedHod,
  type AuthRequest,
} from "../middleware/auth.js";
import { calculateCalendarDays, createApplication, decide } from "../services/workflow.js";
import {
  initializeBalance,
  calendarYear,
  adjustBalance,
  reserveBalance,
  releaseReservation,
} from "../services/accounting.js";
import { processEmailOutbox } from "../services/outbox.js";
import { initializeAnnualBalances } from "../jobs/annualInitialization.js";
import { ensureEmployeeYearBalances, ensureCurrentYearBalances, ensureAllFacultyYearBalances } from "../services/entitlements.js";
import { calculateQuotaChange } from "../services/policyAccounting.js";
import { HttpError } from "../utils/errors.js";
export const router = Router();
router.get("/leave-types", requireAuth, async (_req, res, next) => {
  try {
    res.json({
      data: await LeaveType.find({ active: true })
        .select(
          "name abbreviation description annualEntitlement balancePolicy workflow template policyVersion",
        )
        .sort({ name: 1 })
        .lean(),
    });
  } catch (e) {
    next(e);
  }
});
router.get("/departments", async (_req, res, next) => {
  try {
    const rows = await Department.find({ active: true })
      .sort({ name: 1 })
      .lean();
    res.json({ data: rows.length ? rows : DEPARTMENTS });
  } catch (e) {
    next(e);
  }
});
router.get("/auth/me", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    // First authenticated request automatically provisions this employee's current-year balances.
    await ensureCurrentYearBalances(req.user._id);
    res.json({
      data: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        departmentId: req.user.departmentId,
      },
    });
  } catch (error) {
    next(error);
  }
});
router.post("/auth/logout", (req, res) =>
  req.session.destroy(() => {
    res.clearCookie("sggs.sid");
    res.status(204).end();
  }),
);
router.get(
  "/faculty/dashboard",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      if (!["faculty", "hod"].includes(req.user.role))
        throw new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required.");
      await ensureCurrentYearBalances(req.user._id);
      const [applications, balanceRows] = await Promise.all([
        LeaveApplication.find({ employeeId: req.user._id })
          .populate("leaveTypeId", "name abbreviation")
          .sort({ createdAt: -1 })
          .limit(10)
          .lean(),
        AnnualLeaveBalance.find({
          employeeId: req.user._id,
          year: calendarYear(new Date()),
          assignedEntitlement: { $exists: true },
        })
          .populate("leaveTypeId", "name abbreviation balancePolicy")
          .lean(),
      ]);
      const balances = balanceRows
        .filter((balance: any) => balance.leaveTypeId?.balancePolicy !== "none")
        .map((balance: any) => ({
          ...balance,
          availableBalance: Math.max(0, Number(balance.remainingBalance || 0) - Number(balance.reservedDays || 0)),
        }));
      res.json({ data: { applications, balances } });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/faculty/leave-balances",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      if (!["faculty", "hod"].includes(req.user.role))
        throw new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required.");
      const year = Number(req.query.year) || calendarYear(new Date());
      if (!Number.isInteger(year) || year < 2000 || year > 2200)
        throw new HttpError(400, "INVALID_YEAR", "Year must be between 2000 and 2200.");
      await ensureEmployeeYearBalances(req.user._id, year);
      const rows = await AnnualLeaveBalance.find({
        employeeId: req.user._id,
        year,
        assignedEntitlement: { $exists: true },
      })
        .populate("leaveTypeId", "name abbreviation balancePolicy")
        .lean();
      res.json({ data: rows
        .filter((balance: any) => balance.leaveTypeId?.balancePolicy !== "none")
        .map((balance: any) => ({
          ...balance,
          availableBalance: Math.max(0, Number(balance.remainingBalance || 0) - Number(balance.reservedDays || 0)),
        })) });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/faculty/leave-applications",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      if (!["faculty", "hod"].includes(req.user.role))
        throw new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required.");
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const [data, total] = await Promise.all([
        LeaveApplication.find({ employeeId: req.user._id })
          .populate("leaveTypeId", "name abbreviation")
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        LeaveApplication.countDocuments({ employeeId: req.user._id }),
      ]);
      res.json({ data, pagination: { page, limit, total } });
    } catch (e) {
      next(e);
    }
  },
);
const createSchema = z.object({
  leaveTypeId: z.string().regex(/^[a-f0-9]{24}$/i),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().min(5).max(4000),
  absenceAddress: z.string().max(1000).optional(),
  contactNumber: z.string().max(30).optional(),
  headquartersPermission: z.enum(["yes", "no", "not-applicable"]).optional(),
  substituteDetails: z.string().max(2000).optional(),
});
router.post(
  "/faculty/leave-applications",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      if (!["faculty", "hod"].includes(req.user.role))
        throw new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required.");
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      const app = await createApplication(
        parsed.data,
        req.user,
        req.requestId,
        req.get("Idempotency-Key") || undefined,
      );
      res.status(201).json({ data: app });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/faculty/leave-applications/:id",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      if (!["faculty", "hod"].includes(req.user.role))
        throw new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required.");
      const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user._id })
        .populate("leaveTypeId", "name abbreviation balancePolicy workflow")
        .lean();
      if (!app) throw new HttpError(404, "NOT_FOUND", "Application not found.");
      res.json({ data: app });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/faculty/leave-applications/:id",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    if (!["faculty", "hod"].includes(req.user.role))
      return next(new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required."));
    const session = await mongoose.startSession();
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success)
        throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; "));
      let output: any;
      await session.withTransaction(async () => {
        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user._id }).session(session);
        if (!app) throw new HttpError(404, "NOT_FOUND", "Application draft not found.");
        if (!["Draft", "Returned by HOD", "Returned by Admin"].includes(app.status))
          throw new HttpError(409, "INVALID_TRANSITION", "Only drafts and returned applications can be edited.");
        if (app.balanceReserved)
          throw new HttpError(409, "BALANCE_RESERVED", "This application still has a reserved balance. Withdraw or resolve it before editing.");
        const start = new Date(parsed.data.startDate);
        const end = new Date(parsed.data.endDate);
        if (calendarYear(start) !== calendarYear(end))
          throw new HttpError(400, "CROSS_YEAR_REVIEW", "Cross-year requests require configured allocation policy.");
        const department = await Department.findById(req.user.departmentId).session(session);
        if (!department?.hodId)
          throw new HttpError(409, "HOD_UNASSIGNED", "Your department must have an assigned HOD before applying.");
        const leaveType = await LeaveType.findOne({ _id: parsed.data.leaveTypeId, active: true }).session(session);
        if (!leaveType)
          throw new HttpError(400, "INVALID_LEAVE_TYPE", "Choose an active leave category.");
        if (leaveType.balancePolicy === "shared")
          throw new HttpError(409, "UNSUPPORTED_BALANCE_POLICY", "Shared leave pools are not implemented. Configure separate individual balances.");
        const overlap = await LeaveApplication.findOne({
          _id: { $ne: app._id },
          employeeId: req.user._id,
          status: { $in: ["Pending HOD", "Returned by HOD", "Pending Admin", "Returned by Admin", "Approved"] },
          startDate: { $lte: end },
          endDate: { $gte: start },
        }).session(session);
        if (overlap)
          throw new HttpError(409, "OVERLAPPING_APPLICATION", "This date range overlaps another active request.");
        const previous = app.status;
        Object.assign(app, {
          departmentId: req.user.departmentId,
          leaveTypeId: leaveType._id,
          startDate: start,
          endDate: end,
          requestedDays: calculateCalendarDays(start, end),
          reason: parsed.data.reason,
          absenceAddress: parsed.data.absenceAddress,
          contactNumber: parsed.data.contactNumber,
          headquartersPermission: parsed.data.headquartersPermission || "no",
          substituteDetails: parsed.data.substituteDetails,
          workflow: leaveType.workflow,
          policyVersion: leaveType.policyVersion,
          submittedSnapshot: undefined,
        });
        app.version += 1;
        await app.save({ session });
        await AuditLog.create([{
          actorId: req.user._id,
          action: "leave.edited",
          entityType: "LeaveApplication",
          entityId: String(app._id),
          requestId: req.requestId,
          before: { status: previous },
          after: { status: app.status, reference: app.reference, requestedDays: app.requestedDays },
        }], { session });
        output = app;
      });
      res.json({ data: output });
    } catch (error) {
      next(error);
    } finally {
      await session.endSession();
    }
  },
);

router.post(
  "/faculty/leave-applications/:id/submit",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    if (!["faculty", "hod"].includes(req.user.role))
      return next(new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required."));
    const session = await (await import("mongoose")).default.startSession();
    try {
      const draftForProvisioning: any = await LeaveApplication.findOne({
        _id: req.params.id,
        employeeId: req.user._id,
      }).select("startDate").lean();
      if (draftForProvisioning) {
        await ensureEmployeeYearBalances(req.user._id, calendarYear(new Date(draftForProvisioning.startDate)));
      }
      let output: any;
      await session.withTransaction(async () => {
        const app = await LeaveApplication.findOne({
          _id: req.params.id,
          employeeId: req.user._id,
        }).session(session);
        if (!app) throw new HttpError(404, "NOT_FOUND", "Draft not found.");
        if (
          !["Draft", "Returned by HOD", "Returned by Admin"].includes(
            app.status,
          )
        )
          throw new HttpError(
            409,
            "INVALID_TRANSITION",
            "Only drafts or returned applications can be submitted.",
          );
        await User.updateOne(
          { _id: req.user._id },
          { $inc: { workflowLock: 1 } },
          { session },
        );
        const dept = await Department.findById(app.departmentId).session(
          session,
        );
        if (!dept?.hodId)
          throw new HttpError(
            409,
            "HOD_UNASSIGNED",
            "Department HOD has not been assigned.",
          );
        const overlap = await LeaveApplication.findOne({
          _id: { $ne: app._id },
          employeeId: req.user._id,
          status: {
            $in: [
              "Pending HOD",
              "Returned by HOD",
              "Pending Admin",
              "Returned by Admin",
              "Approved",
            ],
          },
          startDate: { $lte: app.endDate },
          endDate: { $gte: app.startDate },
        }).session(session);
        if (overlap)
          throw new HttpError(
            409,
            "OVERLAPPING_APPLICATION",
            "This date range overlaps another active request.",
          );

        const leaveType = await LeaveType.findById(app.leaveTypeId).session(session);
        if (!leaveType || !leaveType.active)
          throw new HttpError(409, "LEAVE_TYPE_UNAVAILABLE", "This leave category is no longer active.");
        const startYear = calendarYear(new Date(app.startDate));
        const endYear = calendarYear(new Date(app.endDate));
        if (startYear !== endYear)
          throw new HttpError(409, "CROSS_YEAR_REVIEW", "Cross-year requests require an approved allocation policy.");
        if (leaveType.balancePolicy === "shared")
          throw new HttpError(409, "UNSUPPORTED_BALANCE_POLICY", "Shared leave pools are not implemented. Assign a separate balance for this faculty member.");
        if (leaveType.balancePolicy === "separate") {
          const entitlement = await FacultyLeaveEntitlement.findOne({
            employeeId: req.user._id,
            leaveTypeId: leaveType._id,
            year: startYear,
          }).session(session);
          if (!entitlement)
            throw new HttpError(409, "BALANCE_NOT_ASSIGNED", "The system could not find an automatically provisioned balance for this year. Refresh and retry, or contact support if the problem continues.");
          await reserveBalance({
            employeeId: req.user._id,
            leaveTypeId: leaveType._id,
            year: startYear,
            days: app.requestedDays,
            applicationId: app._id,
            actorId: req.user._id,
            reason: `Reservation for ${app.reference}`,
            idempotencyKey: `reserve:${app._id}:${app.version + 1}`,
            session,
          });
          app.balanceReserved = true;
        }

        const previous = app.status;
        const isHodSelfRequest = req.user.role === "hod" && String(dept.hodId) === String(req.user._id);
        // Route stale drafts to the employee's current department after a transfer.
        app.departmentId = req.user.departmentId;
        app.workflow = isHodSelfRequest ? "both" : leaveType.workflow;
        app.status = isHodSelfRequest ? "Pending Admin" : "Pending HOD";
        app.submittedSnapshot = app.toObject();
        app.version += 1;
        await app.save({ session });
        await ApprovalAction.create(
          [
            {
              applicationId: app._id,
              actorId: req.user._id,
              actorRole: req.user.role,
              action: "submit",
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
              actorId: req.user._id,
              action: "leave.submitted",
              entityType: "LeaveApplication",
              entityId: String(app._id),
              requestId: req.requestId,
              before: { status: previous },
              after: { status: app.status },
            },
          ],
          { session },
        );
        const recipients = isHodSelfRequest
          ? await User.find({ role: "admin", active: true, provisioned: true }).select("email").session(session)
          : [await User.findById(dept.hodId).session(session)].filter(Boolean);
        const jobs = recipients.filter((reviewer: any) => reviewer?.email).map((reviewer: any) => ({
          recipient: reviewer.email,
          eventType: isHodSelfRequest ? "leave.hod-self-request-submitted" : "leave.submitted",
          applicationId: app._id,
          payload: {
            subject: isHodSelfRequest ? `HOD leave request ${app.reference} needs establishment review` : `Leave request ${app.reference} needs HOD review`,
            text: `${req.user.name} submitted ${app.reference} for ${app.requestedDays} day(s). Sign in to the SGGSIE&T Leave Portal to review it.`,
          },
          status: "pending",
        }));
        if (jobs.length) await EmailOutbox.create(jobs, { session });
        output = app;
      });
      res.json({ data: output });
    } catch (e) {
      next(e);
    } finally {
      await session.endSession();
    }
  },
);
router.post(
  "/faculty/leave-applications/:id/withdraw",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    if (!["faculty", "hod"].includes(req.user.role))
      return next(new HttpError(403, "FORBIDDEN", "Faculty or HOD employee role required."));
    const session = await (await import("mongoose")).default.startSession();
    try {
      let output: any;
      await session.withTransaction(async () => {
        const app = await LeaveApplication.findOne({
          _id: req.params.id,
          employeeId: req.user._id,
        }).session(session);
        if (!app)
          throw new HttpError(404, "NOT_FOUND", "Application not found.");
        if (
          ![
            "Draft",
            "Pending HOD",
            "Returned by HOD",
            "Pending Admin",
            "Returned by Admin",
          ].includes(app.status)
        )
          throw new HttpError(
            409,
            "INVALID_TRANSITION",
            "This application can no longer be withdrawn.",
          );
        const prev = app.status;
        if (app.balanceReserved) {
          await releaseReservation({
            employeeId: app.employeeId,
            leaveTypeId: app.leaveTypeId,
            year: calendarYear(new Date(app.startDate)),
            days: app.requestedDays,
            applicationId: app._id,
            actorId: req.user._id,
            reason: `Reservation released because ${app.reference} was withdrawn`,
            idempotencyKey: `release:${app._id}:${app.version + 1}:withdraw`,
            session,
          });
          app.balanceReserved = false;
        }
        app.status = "Withdrawn";
        app.version += 1;
        await app.save({ session });
        await ApprovalAction.create(
          [
            {
              applicationId: app._id,
              actorId: req.user._id,
              actorRole: req.user.role,
              action: "withdraw",
              previousStatus: prev,
              newStatus: app.status,
            },
          ],
          { session },
        );
        await AuditLog.create(
          [
            {
              actorId: req.user._id,
              action: "leave.withdrawn",
              entityType: "LeaveApplication",
              entityId: String(app._id),
              requestId: req.requestId,
              before: { status: prev },
              after: { status: app.status },
            },
          ],
          { session },
        );
        output = app;
      });
      res.json({ data: output });
    } catch (e) {
      next(e);
    } finally {
      await session.endSession();
    }
  },
);
router.get(
  "/leave-applications/:id/pdf",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      const app = await LeaveApplication.findById(req.params.id)
        .populate("employeeId", "name email designation departmentId")
        .populate("departmentId", "name code")
        .populate("leaveTypeId", "name abbreviation");
      if (!app) throw new HttpError(404, "NOT_FOUND", "Application not found.");
      const employee: any = app.employeeId;
      const own = String(employee?._id) === String(req.user._id);
      const deptId =
        (app.departmentId as any)?._id || (app.departmentId as any);
      const assignedHod =
        req.user.role === "hod" &&
        String(req.user.departmentId) === String(deptId) &&
        Boolean(await Department.exists({ _id: deptId, hodId: req.user._id }));
      if (!own && !assignedHod && req.user.role !== "admin")
        throw new HttpError(
          403,
          "FORBIDDEN",
          "You cannot download this application.",
        );
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 52, bottom: 52, left: 54, right: 54 },
        info: {
          Title: `Leave Application ${app.reference}`,
          Author: "SGGSIE&T Leave Portal",
        },
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${app.reference}.pdf"`,
      );
      doc.pipe(res);
      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .text(
          "SHRI GURU GOBIND SINGHJI INSTITUTE OF ENGINEERING & TECHNOLOGY",
          { align: "center" },
        );
      doc
        .fontSize(9)
        .font("Helvetica")
        .text("Vishnupuri, Nanded, Maharashtra – 431606, India", {
          align: "center",
        });
      doc.moveDown();
      doc
        .fontSize(15)
        .font("Helvetica-Bold")
        .text("APPLICATION FOR LEAVE", { align: "center" });
      doc.moveDown();
      const field = (label: string, value: any) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(label, { continued: true });
        doc.font("Helvetica").text(` ${value || "—"}`);
      };
      field("Reference:", app.reference);
      field("Status:", app.status);
      field("Employee:", employee?.name);
      field("Email:", employee?.email);
      field("Designation:", employee?.designation);
      field("Department:", (app.departmentId as any)?.name);
      field("Nature of leave:", (app.leaveTypeId as any)?.name);
      field("From date:", new Date(app.startDate).toLocaleDateString("en-IN"));
      field("To date:", new Date(app.endDate).toLocaleDateString("en-IN"));
      field("Requested days:", app.requestedDays);
      doc.moveDown();
      doc.font("Helvetica-Bold").text("Reason for leave");
      doc.font("Helvetica").text(app.reason || "—");
      doc.moveDown();
      field("Address during absence:", app.absenceAddress);
      field("Contact number:", app.contactNumber);
      field("Permission to leave headquarters:", app.headquartersPermission);
      field("Substitute / additional charge:", app.substituteDetails);
      doc.moveDown();
      doc.font("Helvetica-Bold").text("HOD / Establishment remarks");
      doc
        .font("Helvetica")
        .text(app.finalDecision?.remarks || "No final sanction recorded.");
      if (app.status === "Approved" && app.finalDecision?.approvedAt) {
        doc.moveDown();
        field("Final decision:", "SANCTIONED");
        field(
          "Approved on:",
          new Date(app.finalDecision.approvedAt).toLocaleString("en-IN"),
        );
      } else {
        doc.moveDown();
        doc
          .fontSize(9)
          .text(
            "NOT SANCTIONED — This document is a request record and does not constitute approval.",
            { align: "center" },
          );
      }
      doc.moveDown(3);
      doc
        .fontSize(9)
        .text("Employee signature: ____________________", { continued: true });
      doc.text("      HOD: ____________________", { continued: true });
      doc.text("      Establishment: ____________________");
      doc.end();
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/hod/dashboard",
  requireAuth,
  requireAssignedHod,
  async (req: AuthRequest, res, next) => {
    try {
      const filter = { departmentId: req.user.departmentId };
      const [pending, total] = await Promise.all([
        LeaveApplication.countDocuments({ ...filter, status: "Pending HOD" }),
        LeaveApplication.countDocuments(filter),
      ]);
      res.json({ data: { pending, total } });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/hod/faculty",
  requireAuth,
  requireAssignedHod,
  async (req: AuthRequest, res, next) => {
    try {
      const data = await User.find({
        role: "faculty",
        departmentId: req.user.departmentId,
        active: true,
        provisioned: true,
      })
        .select("name email designation active")
        .sort({ name: 1 })
        .lean();
      res.json({ data });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/hod/leave-applications",
  requireAuth,
  requireAssignedHod,
  async (req: AuthRequest, res, next) => {
    try {
      const filter: any = { departmentId: req.user.departmentId };
      if (req.query.status) filter.status = String(req.query.status);
      const data = await LeaveApplication.find(filter)
        .populate("employeeId", "name email designation")
        .populate("leaveTypeId", "name abbreviation")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      res.json({ data });
    } catch (e) {
      next(e);
    }
  },
);
for (const action of ["approve", "reject", "return"] as const)
  router.post(
    `/hod/leave-applications/:id/${action}`,
    requireAuth,
    requireAssignedHod,
    async (req: AuthRequest, res, next) => {
      try {
        const app = await decide({
          applicationId: req.params.id,
          actor: req.user,
          action,
          remarks: String(req.body?.remarks || ""),
          requestId: req.requestId,
        });
        res.json({ data: app });
      } catch (e) {
        next(e);
      }
    },
  );
router.get(
  "/admin/dashboard",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      const [departments, users, pending, approved] = await Promise.all([
        Department.countDocuments({ active: true }),
        User.countDocuments({ active: true, provisioned: true }),
        LeaveApplication.countDocuments({ status: "Pending Admin" }),
        LeaveApplication.countDocuments({ status: "Approved" }),
      ]);
      res.json({ data: { departments, users, pending, approved } });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/admin/leave-applications",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const filter: any = {};
      if (req.query.status) filter.status = String(req.query.status);
      const data = await LeaveApplication.find(filter)
        .populate("employeeId", "name email")
        .populate("departmentId", "name code")
        .populate("leaveTypeId", "name abbreviation")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
      res.json({ data });
    } catch (e) {
      next(e);
    }
  },
);
for (const action of ["approve", "reject", "return"] as const)
  router.post(
    `/admin/leave-applications/:id/${action}`,
    requireAuth,
    requireRole("admin"),
    async (req: AuthRequest, res, next) => {
      try {
        const app = await decide({
          applicationId: req.params.id,
          actor: req.user,
          action,
          remarks: String(req.body?.remarks || ""),
          requestId: req.requestId,
        });
        res.json({ data: app });
      } catch (e) {
        next(e);
      }
    },
  );
router.get(
  "/admin/leave-balances",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const year = Number(req.query.year) || calendarYear(new Date());
      if (!Number.isInteger(year) || year < 2000 || year > 2200)
        throw new HttpError(400, "INVALID_YEAR", "Year must be between 2000 and 2200.");
      const filter: any = { year };
      if (req.query.employeeId) {
        const employeeId = String(req.query.employeeId);
        if (!mongoose.isValidObjectId(employeeId))
          throw new HttpError(400, "INVALID_EMPLOYEE", "Employee ID is invalid.");
        filter.employeeId = employeeId;
      }
      const [balances, entitlements] = await Promise.all([
        AnnualLeaveBalance.find(filter)
          .populate("employeeId", "name email role active provisioned")
          .populate("leaveTypeId", "name abbreviation balancePolicy active")
          .sort({ employeeId: 1, leaveTypeId: 1 })
          .lean(),
        FacultyLeaveEntitlement.find({
          year,
          ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
        }).lean(),
      ]);
      const byKey = new Map(entitlements.map((entry: any) => [`${entry.employeeId}:${entry.leaveTypeId}`, entry]));
      const data = balances.map((balance: any) => {
        const employeeId = String(balance.employeeId?._id || balance.employeeId);
        const leaveTypeId = String(balance.leaveTypeId?._id || balance.leaveTypeId);
        const entitlement = byKey.get(`${employeeId}:${leaveTypeId}`) as any;
        return {
          ...balance,
          individuallyAssigned: Boolean(entitlement),
          assignedDays: entitlement?.days ?? balance.assignedEntitlement ?? null,
          availableBalance: Math.max(0, Number(balance.remainingBalance || 0) - Number(balance.reservedDays || 0)),
          entitlementId: entitlement?._id ?? null,
        };
      });
      res.json({ data, year });
    } catch (error) {
      next(error);
    }
  },
);

// Entitlements are provisioned automatically from institutional policy; there is intentionally no per-faculty assignment endpoint.

router.post(
  "/admin/leave-balances/initialize-year",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    try {
      const year = Number(req.body?.year) || calendarYear(new Date());
      const result = await initializeAnnualBalances(year, String(req.user._id));
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);
router.get(
  "/admin/audit-logs",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const [data, total] = await Promise.all([
        AuditLog.find()
          .sort({ createdAt: -1 })
          .skip((page - 1) * 50)
          .limit(50)
          .lean(),
        AuditLog.countDocuments(),
      ]);
      res.json({ data, pagination: { page, limit: 50, total } });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/admin/reports/leave-utilization",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const year = Number(req.query.year) || calendarYear(new Date());
      if (!Number.isInteger(year) || year < 2000 || year > 2200)
        throw new HttpError(400, "INVALID_YEAR", "Year must be between 2000 and 2200.");
      const rows = await AnnualLeaveBalance.aggregate([
        { $match: { year, assignedEntitlement: { $exists: true } } },
        {
          $group: {
            _id: "$leaveTypeId",
            employees: { $sum: 1 },
            opening: { $sum: "$assignedEntitlement" },
            consumed: { $sum: "$consumedDays" },
            remaining: { $sum: "$remainingBalance" },
            reserved: { $sum: { $ifNull: ["$reservedDays", 0] } },
            available: { $sum: { $subtract: ["$remainingBalance", { $ifNull: ["$reservedDays", 0] }] } },
          },
        },
        {
          $lookup: {
            from: "leavetypes",
            localField: "_id",
            foreignField: "_id",
            as: "leaveType",
          },
        },
        { $unwind: { path: "$leaveType", preserveNullAndEmptyArrays: true } },
        { $match: { $or: [{ "leaveType.balancePolicy": "separate" }, { "leaveType.balancePolicy": { $exists: false } }] } },
        {
          $project: {
            _id: 0,
            category: "$leaveType.name",
            employees: 1,
            opening: 1,
            consumed: 1,
            remaining: 1,
            reserved: 1,
            available: 1,
          },
        },
      ]);
      res.json({ data: rows, year });
    } catch (e) {
      next(e);
    }
  },
);


router.post(
  "/admin/reports/leave-utilization/email",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    try {
      const schema = z.object({
        year: z.number().int().min(2000).max(2200),
        recipient: z.string().trim().email().transform((value) => value.toLowerCase()),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; "));
      const year = parsed.data.year;
      const rows = await AnnualLeaveBalance.aggregate([
        { $match: { year, assignedEntitlement: { $exists: true } } },
        { $group: {
          _id: "$leaveTypeId",
          employees: { $sum: 1 },
          opening: { $sum: "$assignedEntitlement" },
          consumed: { $sum: "$consumedDays" },
          remaining: { $sum: "$remainingBalance" },
          reserved: { $sum: { $ifNull: ["$reservedDays", 0] } },
          available: { $sum: { $subtract: ["$remainingBalance", { $ifNull: ["$reservedDays", 0] }] } },
        }},
        { $lookup: { from: "leavetypes", localField: "_id", foreignField: "_id", as: "leaveType" } },
        { $unwind: { path: "$leaveType", preserveNullAndEmptyArrays: true } },
        { $match: { $or: [{ "leaveType.balancePolicy": "separate" }, { "leaveType.balancePolicy": { $exists: false } }] } },
        { $project: { _id: 0, category: "$leaveType.name", employees: 1, opening: 1, consumed: 1, remaining: 1, reserved: 1, available: 1 } },
      ]);
      const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        ["Year", "Category", "Employees", "Assigned entitlement", "Consumed days", "Reserved days", "Available days"],
        ...rows.map((row: any) => [year, row.category, row.employees, row.opening, row.consumed, row.reserved, row.available]),
      ].map((row) => row.map(csvCell).join(",")).join("\r\n");
      const filename = `sggs-leave-utilization-${year}.csv`;
      const [job] = await EmailOutbox.create([{
        recipient: parsed.data.recipient,
        eventType: "leave-utilization-report",
        payload: {
          subject: `SGGS Leave Utilization Report — ${year}`,
          text: `Attached is the SGGS Leave Utilization Report for ${year}. This report was requested by an authorized administrator.`,
          attachments: [{ filename, contentType: "text/csv; charset=utf-8", contentBase64: Buffer.from(csv, "utf8").toString("base64") }],
          requestedBy: String(req.user._id),
          reportYear: year,
        },
        status: "pending",
      }]);
      await AuditLog.create({
        actorId: req.user._id,
        action: "report.leave-utilization.email-queued",
        entityType: "EmailOutbox",
        entityId: String(job._id),
        requestId: req.requestId,
        metadata: { recipient: parsed.data.recipient, year, filename },
      });
      res.status(202).json({ data: { queued: true, jobId: String(job._id), recipient: parsed.data.recipient, filename }, message: "Report email queued. Delivery occurs when the email outbox worker runs." });
    } catch (error) {
      next(error);
    }
  },
);

// Provisioning and policy endpoints: no public signup and all changes are audited.
router.get(
  "/admin/users",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const filter: any = {};
      if (req.query.role) filter.role = String(req.query.role);
      if (req.query.departmentId)
        filter.departmentId = String(req.query.departmentId);
      const data = await User.find(filter)
        .select("-googleSub")
        .populate("departmentId", "name code")
        .sort({ name: 1 })
        .limit(Math.min(5000, Math.max(1, Number(req.query.limit) || 5000)))
        .lean();
      res.json({ data });
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/admin/users",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    const session = await mongoose.startSession();
    try {
      const schema = z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().transform((value) => value.toLowerCase()),
        designation: z.string().max(120).optional(),
        departmentId: z.string().optional().nullable(),
        role: z.enum(["faculty", "hod", "admin"]),
        active: z.boolean().optional(),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; "));
      const departmentId = parsed.data.role === "admin" ? null : parsed.data.departmentId || null;
      if (parsed.data.role === "hod" && parsed.data.active === false) throw new HttpError(400, "INACTIVE_HOD", "Activate the HOD account before assigning the department's HOD role.");
      if (parsed.data.role !== "admin" && !departmentId) throw new HttpError(400, "DEPARTMENT_REQUIRED", "Faculty and HOD accounts require a department.");
      if (departmentId && !mongoose.isValidObjectId(departmentId)) throw new HttpError(400, "INVALID_DEPARTMENT", "Department ID is invalid.");

      let output: any;
      await session.withTransaction(async () => {
        const existing = await User.findOne({ email: parsed.data.email }).session(session);
        if (existing) throw new HttpError(409, "EMAIL_ALREADY_EXISTS", "An account already exists for this email.");
        let department: any = null;
        if (departmentId) {
          department = await Department.findOne({ _id: departmentId, active: true }).session(session);
          if (!department) throw new HttpError(400, "INVALID_DEPARTMENT", "Select an active department.");
          if (parsed.data.role === "hod" && department.hodId) throw new HttpError(409, "HOD_ALREADY_ASSIGNED", "Remove or reassign the current HOD before assigning a new one.");
        }
        const [user] = await User.create([{
          name: parsed.data.name,
          email: parsed.data.email,
          emailVerified: true,
          designation: parsed.data.designation || "",
          departmentId,
          role: parsed.data.role,
          active: parsed.data.active ?? true,
          provisioned: true,
        }], { session });
        // If this account was already waiting in the Google access queue, link it
        // to this explicitly provisioned user so the request is not left stale.
        const pendingAccessRequest = await AccessRequest.findOne({ email: user.email, status: "pending" }).session(session);
        if (pendingAccessRequest) {
          if (pendingAccessRequest.googleSub) {
            user.googleSub = pendingAccessRequest.googleSub;
            await user.save({ session });
          }
          pendingAccessRequest.status = "approved";
          pendingAccessRequest.userId = user._id;
          pendingAccessRequest.reviewedBy = req.user._id;
          pendingAccessRequest.reviewedAt = new Date();
          pendingAccessRequest.rejectionReason = "";
          await pendingAccessRequest.save({ session });
          await AuditLog.create([{
            actorId: req.user._id,
            action: "access-request.linked-to-provisioned-account",
            entityType: "AccessRequest",
            entityId: String(pendingAccessRequest._id),
            requestId: req.requestId,
            after: { status: "approved", userId: String(user._id), role: user.role, departmentId: user.departmentId },
          }], { session });
        }
        if (parsed.data.role === "hod" && department) {
          const assigned = await Department.findOneAndUpdate(
            { _id: department._id, hodId: null },
            { $set: { hodId: user._id } },
            { new: true, session },
          );
          if (!assigned) throw new HttpError(409, "HOD_ALREADY_ASSIGNED", "Another administrator assigned an HOD to this department. Refresh and retry.");
        }
        await AuditLog.create([{
          actorId: req.user._id,
          action: "account.provisioned",
          entityType: "User",
          entityId: String(user._id),
          requestId: req.requestId,
          after: { email: user.email, role: user.role, departmentId: user.departmentId },
        }], { session });
        output = {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          departmentId: user.departmentId,
          active: user.active,
          provisioned: user.provisioned,
        };
      });
      res.status(201).json({ data: output });
    } catch (error: any) {
      if (error?.code === 11000) next(new HttpError(409, "EMAIL_ALREADY_EXISTS", "An account already exists for this email."));
      else next(error);
    } finally {
      await session.endSession();
    }
  },
);
router.patch(
  "/admin/users/:id",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    const session = await mongoose.startSession();
    try {
      const schema = z
        .object({
          name: z.string().min(2).max(120).optional(),
          designation: z.string().max(120).optional(),
          departmentId: z.string().nullable().optional(),
          role: z.enum(["faculty", "hod", "admin"]).optional(),
          active: z.boolean().optional(),
          provisioned: z.boolean().optional(),
        })
        .strict();
      const p = schema.safeParse(req.body);
      if (!p.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          p.error.issues.map((i) => i.message).join("; "),
        );
      let output: any;
      await session.withTransaction(async () => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) throw new HttpError(404, "NOT_FOUND", "User not found.");
        if (
          String(user._id) === String(req.user._id) &&
          ((p.data.role && p.data.role !== "admin") ||
            p.data.active === false ||
            p.data.provisioned === false)
        )
          throw new HttpError(
            409,
            "SELF_LOCKOUT",
            "You cannot remove your own administrator access here.",
          );
        const nextRole = p.data.role || user.role;
        const nextDepartment = nextRole === "admin"
          ? null
          : p.data.departmentId === undefined
            ? user.departmentId
            : p.data.departmentId;
        if (nextRole !== "admin" && !nextDepartment)
          throw new HttpError(
            400,
            "DEPARTMENT_REQUIRED",
            "Faculty and HOD accounts require a department.",
          );
        if (nextDepartment) {
          const dept =
            await Department.findById(nextDepartment).session(session);
          if (!dept)
            throw new HttpError(
              400,
              "INVALID_DEPARTMENT",
              "Department not found.",
            );
          if (
            nextRole === "hod" &&
            dept.hodId &&
            String(dept.hodId) !== String(user._id)
          )
            throw new HttpError(
              409,
              "HOD_ALREADY_ASSIGNED",
              "This department already has an assigned HOD.",
            );
        }
        const before = {
          role: user.role,
          departmentId: user.departmentId,
          active: user.active,
          provisioned: user.provisioned,
        };
        if (
          user.role === "hod" &&
          (nextRole !== "hod" ||
            String(nextDepartment || "") !== String(user.departmentId || "") ||
            p.data.active === false ||
            p.data.provisioned === false)
        )
          await Department.updateMany(
            { hodId: user._id },
            { $set: { hodId: null } },
            { session },
          );
        Object.assign(user, p.data);
        if (nextRole === "admin") user.departmentId = null;
        await user.save({ session });
        if (
          user.role === "hod" &&
          user.departmentId &&
          user.active &&
          user.provisioned
        )
          await Department.findByIdAndUpdate(
            user.departmentId,
            { hodId: user._id },
            { session },
          );
        await AuditLog.create(
          [
            {
              actorId: req.user._id,
              action: "account.updated",
              entityType: "User",
              entityId: String(user._id),
              requestId: req.requestId,
              before,
              after: {
                role: user.role,
                departmentId: user.departmentId,
                active: user.active,
                provisioned: user.provisioned,
              },
            },
          ],
          { session },
        );
        output = {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          departmentId: user.departmentId,
          active: user.active,
          provisioned: user.provisioned,
        };
      });
      res.json({ data: output });
    } catch (e) {
      next(e);
    } finally {
      await session.endSession();
    }
  },
);
router.get(
  "/admin/departments",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      res.json({
        data: await Department.find()
          .populate("hodId", "name email")
          .sort({ name: 1 })
          .lean(),
      });
    } catch (e) {
      next(e);
    }
  },
);
router.patch(
  "/admin/departments/:id/hod",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    try {
      const schema = z.object({ hodId: z.string().nullable() });
      const p = schema.safeParse(req.body);
      if (!p.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "hodId must be a user ID or null.",
        );
      const dept = await Department.findById(req.params.id);
      if (!dept) throw new HttpError(404, "NOT_FOUND", "Department not found.");
      let nextHod: any = null;
      if (p.data.hodId) {
        nextHod = await User.findOne({
          _id: p.data.hodId,
          role: "hod",
          active: true,
          provisioned: true,
          departmentId: dept._id,
        });
        if (!nextHod)
          throw new HttpError(
            400,
            "INVALID_HOD",
            "Select an active, provisioned HOD assigned to this department.",
          );
      }
      const before = String(dept.hodId || "");
      dept.hodId = nextHod?._id || null;
      await dept.save();
      await AuditLog.create({
        actorId: req.user._id,
        action: "department.hod-reassigned",
        entityType: "Department",
        entityId: String(dept._id),
        requestId: req.requestId,
        before: { hodId: before },
        after: { hodId: String(dept.hodId || "") },
      });
      res.json({ data: dept });
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/admin/leave-types",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      res.json({ data: await LeaveType.find().sort({ name: 1 }).lean() });
    } catch (e) {
      next(e);
    }
  },
);
router.patch(
  "/admin/leave-types/:id",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    const session = await mongoose.startSession();
    try {
      const schema = z.object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1000).optional(),
        annualEntitlement: z.number().int().min(0).max(366).optional(),
        balancePolicy: z.enum(["separate", "none"]).optional(),
        workflow: z.enum(["hod", "both"]).optional(),
        template: z.enum(["letter", "application", "both"]).optional(),
        active: z.boolean().optional(),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; "));

      const beforeType: any = await LeaveType.findById(req.params.id).lean();
      if (!beforeType) throw new HttpError(404, "NOT_FOUND", "Leave category not found.");
      const currentYear = calendarYear(new Date());
      const requestedQuota = parsed.data.annualEntitlement ?? beforeType.annualEntitlement;
      const quotaChanged = requestedQuota !== beforeType.annualEntitlement;
      const enablingIndividualBalance = parsed.data.balancePolicy === "separate" && beforeType.balancePolicy !== "separate";

      // Provision every active employee using the OLD policy before changing a quota.
      // That lets the delta be applied to every current-year balance exactly once.
      if (beforeType.balancePolicy === "separate" && (quotaChanged || parsed.data.active === true)) {
        await ensureAllFacultyYearBalances(currentYear, String(req.user._id));
      }

      if (parsed.data.balancePolicy === "none" && beforeType.balancePolicy !== "none") {
        const activeReservation = await LeaveApplication.exists({
          leaveTypeId: beforeType._id,
          balanceReserved: true,
          status: { $in: ["Pending HOD", "Pending Admin", "Returned by HOD", "Returned by Admin"] },
        });
        if (activeReservation) throw new HttpError(409, "ACTIVE_RESERVATIONS", "Resolve applications with reserved days before switching this category to no-balance policy.");
      }

      let output: any;
      await session.withTransaction(async () => {
        const type = await LeaveType.findById(req.params.id).session(session);
        if (!type) throw new HttpError(404, "NOT_FOUND", "Leave category not found.");
        // Protect against a stale admin page overwriting a newer policy edit.
        if (Number(type.policyVersion) !== Number(beforeType.policyVersion)) {
          throw new HttpError(409, "POLICY_VERSION_CONFLICT", "This policy changed in another session. Reload the page and try again.");
        }
        const before = type.toObject();
        const now = new Date();
        const nextVersion = Number(type.policyVersion || 1) + 1;
        const appliesToCurrentBalances = (parsed.data.balancePolicy ?? type.balancePolicy) === "separate" && (quotaChanged || enablingIndividualBalance);

        if (appliesToCurrentBalances) {
          const balances: any[] = await AnnualLeaveBalance.find({ leaveTypeId: type._id, year: currentYear }).session(session).lean();
          const entitlementByEmployee = new Map<string, any>();
          const entitlements: any[] = await FacultyLeaveEntitlement.find({ leaveTypeId: type._id, year: currentYear }).session(session).lean();
          for (const entitlement of entitlements) entitlementByEmployee.set(String(entitlement.employeeId), entitlement);

          const balanceOps: any[] = [];
          const entitlementOps: any[] = [];
          const transactions: any[] = [];
          for (const balance of balances) {
            const oldAssigned = Number(balance.assignedEntitlement ?? balance.openingBalance ?? 0);
            const remainingBefore = Number(balance.remainingBalance || 0);
            const reserved = Number(balance.reservedDays || 0);
            let adjustment: { delta: number; remainingAfter: number };
            try {
              adjustment = calculateQuotaChange({ oldEntitlement: oldAssigned, newEntitlement: requestedQuota, remainingBalance: remainingBefore, reservedDays: reserved });
            } catch (error: any) {
              if (error?.code === "POLICY_QUOTA_BELOW_USAGE") {
                throw new HttpError(409, "POLICY_QUOTA_BELOW_USAGE", `Cannot change ${type.abbreviation} to ${requestedQuota} days: at least one current-year balance has already used or reserved more days than the new quota permits. Reconcile that record before retrying.`);
              }
              throw error;
            }
            const { delta, remainingAfter } = adjustment;
            balanceOps.push({ updateOne: {
              filter: { _id: balance._id },
              update: {
                $set: { assignedEntitlement: requestedQuota, policyVersion: nextVersion },
                ...(delta ? { $inc: { remainingBalance: delta, adjustments: delta } } : {}),
              },
            }});
            const priorEntitlement = entitlementByEmployee.get(String(balance.employeeId));
            if (priorEntitlement) {
              entitlementOps.push({ updateOne: {
                filter: { _id: priorEntitlement._id },
                update: { $set: { days: requestedQuota, policyVersion: nextVersion, assignedBy: req.user._id, assignedAt: now, reason: `Updated automatically from institutional policy version ${nextVersion}.` } },
              }});
            } else {
              entitlementOps.push({ updateOne: {
                filter: { employeeId: balance.employeeId, leaveTypeId: type._id, year: currentYear },
                update: { $set: { days: requestedQuota, policyVersion: nextVersion, assignedBy: req.user._id, assignedAt: now, reason: `Updated automatically from institutional policy version ${nextVersion}.` }, $setOnInsert: { employeeId: balance.employeeId, leaveTypeId: type._id, year: currentYear } },
                upsert: true,
              }});
            }
            if (delta !== 0) transactions.push({
              employeeId: balance.employeeId,
              leaveTypeId: type._id,
              year: currentYear,
              type: "adjustment",
              days: delta,
              balanceBefore: remainingBefore,
              balanceAfter: remainingAfter,
              reservedBefore: reserved,
              reservedAfter: reserved,
              actorId: req.user._id,
              reason: `Institutional quota changed from ${oldAssigned} to ${requestedQuota} days (policy version ${nextVersion}).`,
              idempotencyKey: `policy-quota:${type._id}:${currentYear}:${nextVersion}:${balance.employeeId}`,
            });
          }
          if (balanceOps.length) await AnnualLeaveBalance.bulkWrite(balanceOps, { session });
          if (entitlementOps.length) await FacultyLeaveEntitlement.bulkWrite(entitlementOps, { session });
          // Also reconcile any older entitlement-only records that do not have a
          // matching balance row, so no faculty record keeps a stale quota value.
          await FacultyLeaveEntitlement.updateMany(
            { leaveTypeId: type._id, year: currentYear },
            { $set: { days: requestedQuota, policyVersion: nextVersion, assignedBy: req.user._id, assignedAt: now, reason: `Updated automatically from institutional policy version ${nextVersion}.` } },
            { session },
          );
          if (transactions.length) await LeaveTransaction.insertMany(transactions, { session, ordered: true });
        }

        // Preserve policy history: close the previously active version and create
        // a new version effective immediately. New requests use the new route;
        // already-submitted applications retain their workflow/policy snapshot.
        let currentPolicy = await LeavePolicy.findOne({ leaveTypeId: type._id, version: type.policyVersion }).session(session);
        if (!currentPolicy) {
          await LeavePolicy.create([{
            leaveTypeId: type._id,
            version: type.policyVersion,
            annualEntitlement: before.annualEntitlement,
            accountingPeriod: "calendar-year",
            effectiveFrom: new Date(Date.UTC(currentYear, 0, 1)),
            carryForward: false,
            createdBy: req.user._id,
            notes: "Baseline policy version recorded before immediate policy update.",
          }], { session });
          currentPolicy = await LeavePolicy.findOne({ leaveTypeId: type._id, version: type.policyVersion }).session(session);
        }
        if (currentPolicy && (!currentPolicy.effectiveTo || currentPolicy.effectiveTo >= now)) {
          // Older builds sometimes stored the active version with a next-year
          // effective date. Normalize that legacy record before closing it.
          if (currentPolicy.effectiveFrom > now) {
            currentPolicy.effectiveFrom = new Date(Date.UTC(currentYear, 0, 1));
            currentPolicy.annualEntitlement = before.annualEntitlement;
          }
          currentPolicy.effectiveTo = new Date(now.getTime() - 1);
          await currentPolicy.save({ session });
        }

        Object.assign(type, parsed.data);
        type.policyVersion = nextVersion;
        await type.save({ session });
        await LeavePolicy.create([{
          leaveTypeId: type._id,
          version: type.policyVersion,
          annualEntitlement: type.annualEntitlement,
          accountingPeriod: "calendar-year",
          effectiveFrom: now,
          carryForward: false,
          createdBy: req.user._id,
          notes: "Effective immediately; current-year faculty balances reconciled without erasing consumption or reservations.",
        }], { session });

        if (!appliesToCurrentBalances && type.balancePolicy === "separate") {
          await AnnualLeaveBalance.updateMany({ leaveTypeId: type._id, year: currentYear }, { $set: { policyVersion: nextVersion } }, { session });
          await FacultyLeaveEntitlement.updateMany({ leaveTypeId: type._id, year: currentYear }, { $set: { policyVersion: nextVersion } }, { session });
        }
        await AuditLog.create([{
          actorId: req.user._id,
          action: "leave-policy.updated",
          entityType: "LeaveType",
          entityId: String(type._id),
          requestId: req.requestId,
          before: { annualEntitlement: before.annualEntitlement, workflow: before.workflow, balancePolicy: before.balancePolicy, active: before.active, policyVersion: before.policyVersion },
          after: { annualEntitlement: type.annualEntitlement, workflow: type.workflow, balancePolicy: type.balancePolicy, active: type.active, policyVersion: type.policyVersion, effectiveFrom: now, currentYearBalancesUpdated: appliesToCurrentBalances },
          metadata: { currentYear, quotaChanged, balancesUpdated: appliesToCurrentBalances },
        }], { session });
        output = type;
      });

      // If a category was activated or switched from no-balance to individual
      // accounting, initialize missing current-year records for every eligible user.
      if ((parsed.data.active === true || enablingIndividualBalance) && output?.active && output?.balancePolicy === "separate") {
        await ensureAllFacultyYearBalances(currentYear, String(req.user._id));
      }
      res.json({ data: output, currentYear, balancesUpdated: Boolean(output?.balancePolicy === "separate" && quotaChanged) });
    } catch (error: any) {
      if (error?.code === 11000) next(new HttpError(409, "POLICY_VERSION_CONFLICT", "This policy was changed concurrently or a ledger key already exists. Reload the page and try again."));
      else next(error);
    } finally {
      await session.endSession();
    }
  },
);

router.post(
  "/admin/leave-balances/:id/adjust",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    const session = await mongoose.startSession();
    try {
      const schema = z.object({
        delta: z.number().int().min(-366).max(366),
        reason: z.string().min(5).max(500),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          p.error.issues.map((i) => i.message).join("; "),
        );
      let result: any;
      await session.withTransaction(async () => {
        const b = await AnnualLeaveBalance.findById(req.params.id).session(
          session,
        );
        if (!b)
          throw new HttpError(404, "BALANCE_NOT_FOUND", "Balance not found.");
        const entitlement = await FacultyLeaveEntitlement.findOne({
          employeeId: b.employeeId,
          leaveTypeId: b.leaveTypeId,
          year: b.year,
        }).session(session);
        if (!entitlement)
          throw new HttpError(409, "BALANCE_NOT_ASSIGNED", "Automatic provisioning has not created an entitlement for this legacy balance yet. Run annual initialization before making a correction.");
        const idem = req.get("Idempotency-Key");
        if (!idem || idem.length > 120)
          throw new HttpError(
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            "Supply an Idempotency-Key header for balance adjustments.",
          );
        result = await adjustBalance({
          employeeId: b.employeeId,
          leaveTypeId: b.leaveTypeId,
          year: b.year,
          delta: p.data.delta,
          actorId: req.user._id,
          reason: p.data.reason,
          idempotencyKey: `adjust:${req.params.id}:${idem}`,
          session,
        });
        await AuditLog.create(
          [
            {
              actorId: req.user._id,
              action: "balance.adjusted",
              entityType: "AnnualLeaveBalance",
              entityId: String(b._id),
              requestId: req.requestId,
              metadata: { delta: p.data.delta, reason: p.data.reason },
            },
          ],
          { session },
        );
      });
      res.json({ data: result });
    } catch (e) {
      next(e);
    } finally {
      await session.endSession();
    }
  },
);
router.get(
  "/admin/email-delivery-logs",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      res.json({
        data: await EmailOutbox.find()
          .sort({ createdAt: -1 })
          .limit(200)
          .select("-payload")
          .lean(),
      });
    } catch (e) {
      next(e);
    }
  },
);
router.get("/internal/initialize-year", async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.get("authorization") !== `Bearer ${secret}`)
      throw new HttpError(401, "UNAUTHORIZED", "Invalid job authorization.");
    const year = Number(req.query.year ?? req.body?.year) || calendarYear(new Date());
    res.json({ data: await initializeAnnualBalances(year) });
  } catch (e) {
    next(e);
  }
});
router.get("/internal/process-outbox", async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.get("authorization") !== `Bearer ${secret}`)
      throw new HttpError(401, "UNAUTHORIZED", "Invalid job authorization.");
    res.json({ data: await processEmailOutbox() });
  } catch (e) {
    next(e);
  }
});

// First-time account access is granted only by an existing administrator.
router.get(
  "/admin/access-requests",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      const [data, departments] = await Promise.all([
        AccessRequest.find({ status: "pending" })
          .select("name email status createdAt")
          .sort({ createdAt: 1 })
          .lean(),
        Department.find({ active: true })
          .select("_id name code")
          .sort({ name: 1 })
          .lean(),
      ]);
      res.json({ data, departments });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/admin/access-requests/:id",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("reject"), reason: z.string().max(500).optional() }),
      z.object({
        action: z.literal("approve"),
        role: z.enum(["faculty", "hod", "admin"]),
        departmentId: z.string().nullable().optional(),
        designation: z.string().max(120).optional(),
      }),
    ]);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(new HttpError(400, "VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; ")));
    }

    const dbSession = await mongoose.startSession();
    try {
      let output: any;
      await dbSession.withTransaction(async () => {
        const request = await AccessRequest.findById(req.params.id).session(dbSession);
        if (!request) throw new HttpError(404, "NOT_FOUND", "Access request not found.");
        if (request.status !== "pending") throw new HttpError(409, "REQUEST_ALREADY_REVIEWED", "This access request has already been reviewed.");
        const before = { status: request.status };

        if (parsed.data.action === "reject") {
          request.status = "rejected";
          request.reviewedBy = req.user._id;
          request.reviewedAt = new Date();
          request.rejectionReason = parsed.data.reason?.trim() || "";
          await request.save({ session: dbSession });
          await AuditLog.create([{
            actorId: req.user._id,
            action: "access-request.rejected",
            entityType: "AccessRequest",
            entityId: String(request._id),
            requestId: req.requestId,
            before,
            after: { status: "rejected", reason: request.rejectionReason },
          }], { session: dbSession });
          output = { id: request._id, status: request.status };
          return;
        }

        const { role, designation } = parsed.data;
        const departmentId = parsed.data.departmentId || null;
        if (role !== "admin" && !departmentId) throw new HttpError(400, "DEPARTMENT_REQUIRED", "Faculty and HOD accounts require a department.");

        let department: any = null;
        if (departmentId) {
          if (!mongoose.isValidObjectId(departmentId)) throw new HttpError(400, "INVALID_DEPARTMENT", "Invalid department ID.");
          department = await Department.findOne({ _id: departmentId, active: true }).session(dbSession);
          if (!department) throw new HttpError(400, "INVALID_DEPARTMENT", "Select an active department.");
          if (role === "hod" && department.hodId) throw new HttpError(409, "HOD_ALREADY_ASSIGNED", "This department already has an assigned HOD.");
        }

        const existingUser = await User.findOne({ email: request.email }).session(dbSession);
        if (existingUser) throw new HttpError(409, "USER_ALREADY_EXISTS", "A user account already exists for this email.");

        const [user] = await User.create([{
          name: request.name,
          email: request.email,
          emailVerified: true,
          googleSub: request.googleSub,
          designation: designation?.trim() || "",
          departmentId: role === "admin" ? null : departmentId,
          role,
          active: true,
          provisioned: true,
        }], { session: dbSession });

        if (role === "hod" && department) {
          department.hodId = user._id;
          await department.save({ session: dbSession });
        }

        request.status = "approved";
        request.reviewedBy = req.user._id;
        request.reviewedAt = new Date();
        request.userId = user._id;
        request.rejectionReason = "";
        await request.save({ session: dbSession });
        await AuditLog.create([{
          actorId: req.user._id,
          action: "access-request.approved",
          entityType: "AccessRequest",
          entityId: String(request._id),
          requestId: req.requestId,
          before,
          after: { status: "approved", userId: String(user._id), role: user.role, departmentId: user.departmentId },
        }], { session: dbSession });
        output = { id: user._id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId, status: request.status };
      });
      res.json({ data: output });
    } catch (error) {
      next(error);
    } finally {
      await dbSession.endSession();
    }
  },
);

