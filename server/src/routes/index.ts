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
import { createApplication, decide } from "../services/workflow.js";
import {
  initializeBalance,
  calendarYear,
  adjustBalance,
} from "../services/accounting.js";
import { processEmailOutbox } from "../services/outbox.js";
import { initializeAnnualBalances } from "../jobs/annualInitialization.js";
import { HttpError } from "../utils/errors.js";
export const router = Router();
router.get("/leave-types", requireAuth, async (_req, res, next) => {
  try {
    res.json({
      data: await LeaveType.find({ active: true })
        .select(
          "name abbreviation description annualEntitlement workflow template policyVersion",
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
router.get("/auth/me", requireAuth, (req: AuthRequest, res) =>
  res.json({
    data: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      departmentId: req.user.departmentId,
    },
  }),
);
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
      if (req.user.role !== "faculty")
        throw new HttpError(403, "FORBIDDEN", "Faculty role required.");
      const [applications, balances] = await Promise.all([
        LeaveApplication.find({ employeeId: req.user._id })
          .populate("leaveTypeId", "name abbreviation")
          .sort({ createdAt: -1 })
          .limit(10)
          .lean(),
        AnnualLeaveBalance.find({
          employeeId: req.user._id,
          year: calendarYear(new Date()),
        })
          .populate("leaveTypeId", "name abbreviation")
          .lean(),
      ]);
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
      if (req.user.role !== "faculty")
        throw new HttpError(403, "FORBIDDEN", "Faculty role required.");
      const year = Number(req.query.year) || calendarYear(new Date());
      res.json({
        data: await AnnualLeaveBalance.find({ employeeId: req.user._id, year })
          .populate("leaveTypeId", "name abbreviation")
          .lean(),
      });
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
      if (req.user.role !== "faculty")
        throw new HttpError(403, "FORBIDDEN", "Faculty role required.");
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
  leaveTypeId: z.string().min(1),
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
      if (req.user.role !== "faculty")
        throw new HttpError(403, "FORBIDDEN", "Faculty role required.");
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
router.post(
  "/faculty/leave-applications/:id/submit",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    if (req.user.role !== "faculty")
      return next(new HttpError(403, "FORBIDDEN", "Faculty role required."));
    const session = await (await import("mongoose")).default.startSession();
    try {
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
        const previous = app.status;
        app.status = "Pending HOD";
        app.submittedSnapshot = app.toObject();
        app.version += 1;
        await app.save({ session });
        await ApprovalAction.create(
          [
            {
              applicationId: app._id,
              actorId: req.user._id,
              actorRole: "faculty",
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
        const hod = await User.findById(dept.hodId).session(session);
        if (hod?.email)
          await EmailOutbox.create(
            [
              {
                recipient: hod.email,
                eventType: "leave.submitted",
                applicationId: app._id,
                payload: {
                  subject: `Leave request ${app.reference} needs HOD review`,
                  text: `${req.user.name} submitted ${app.reference} for ${app.requestedDays} day(s). Sign in to the SGGSIE&T Leave Portal to review it.`,
                },
                status: "pending",
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
router.post(
  "/faculty/leave-applications/:id/withdraw",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    if (req.user.role !== "faculty")
      return next(new HttpError(403, "FORBIDDEN", "Faculty role required."));
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
        app.status = "Withdrawn";
        app.version += 1;
        await app.save({ session });
        await ApprovalAction.create(
          [
            {
              applicationId: app._id,
              actorId: req.user._id,
              actorRole: "faculty",
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
router.post(
  "/admin/leave-balances/initialize-year",
  requireAuth,
  requireRole("admin"),
  async (req: AuthRequest, res, next) => {
    try {
      const year = Number(req.body?.year) || calendarYear(new Date());
      const types = await LeaveType.find({ active: true });
      const people = await User.find({
        active: true,
        provisioned: true,
        role: "faculty",
      });
      let created = 0;
      for (const person of people)
        for (const type of types) {
          const before = await AnnualLeaveBalance.exists({
            employeeId: person._id,
            leaveTypeId: type._id,
            year,
          });
          await initializeBalance({
            employeeId: person._id,
            leaveTypeId: type._id,
            year,
            entitlement: type.annualEntitlement,
            actorId: req.user._id,
            policyVersion: type.policyVersion,
          });
          if (!before) created++;
        }
      await AuditLog.create({
        actorId: req.user._id,
        action: "balance.initialize-year",
        entityType: "AnnualLeaveBalance",
        entityId: String(year),
        requestId: req.requestId,
        metadata: { year, created },
      });
      res.json({
        data: {
          year,
          created,
          employees: people.length,
          categories: types.length,
        },
      });
    } catch (e) {
      next(e);
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
      const rows = await AnnualLeaveBalance.aggregate([
        { $match: { year } },
        {
          $group: {
            _id: "$leaveTypeId",
            employees: { $sum: 1 },
            opening: { $sum: "$openingBalance" },
            consumed: { $sum: "$consumedDays" },
            remaining: { $sum: "$remainingBalance" },
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
        {
          $project: {
            _id: 0,
            category: "$leaveType.name",
            employees: 1,
            opening: 1,
            consumed: 1,
            remaining: 1,
          },
        },
      ]);
      res.json({ data: rows, year });
    } catch (e) {
      next(e);
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
        .limit(500)
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
    try {
      const schema = z.object({
        name: z.string().min(2).max(120),
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
        designation: z.string().max(120).optional(),
        departmentId: z.string().optional().nullable(),
        role: z.enum(["faculty", "hod", "admin"]),
        active: z.boolean().optional(),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          p.error.issues.map((i) => i.message).join("; "),
        );
      if (p.data.role !== "admin" && !p.data.departmentId)
        throw new HttpError(
          400,
          "DEPARTMENT_REQUIRED",
          "Faculty and HOD accounts require a department.",
        );
      if (p.data.role === "hod") {
        const dept = await Department.findById(p.data.departmentId);
        if (!dept)
          throw new HttpError(
            400,
            "INVALID_DEPARTMENT",
            "Department not found.",
          );
        if (dept.hodId)
          throw new HttpError(
            409,
            "HOD_ALREADY_ASSIGNED",
            "Remove or reassign the current HOD before assigning a new one.",
          );
      }
      const user = await User.create({
        name: p.data.name,
        email: p.data.email,
        emailVerified: true,
        designation: p.data.designation || "",
        departmentId: p.data.departmentId || null,
        role: p.data.role,
        active: p.data.active ?? true,
        provisioned: true,
      });
      if (p.data.role === "hod") {
        await Department.findByIdAndUpdate(p.data.departmentId, {
          hodId: user._id,
        });
        user.emailVerified = true;
        await user.save();
      }
      await AuditLog.create({
        actorId: req.user._id,
        action: "account.provisioned",
        entityType: "User",
        entityId: String(user._id),
        requestId: req.requestId,
        after: {
          email: user.email,
          role: user.role,
          departmentId: user.departmentId,
        },
      });
      res
        .status(201)
        .json({
          data: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            departmentId: user.departmentId,
            active: user.active,
            provisioned: user.provisioned,
          },
        });
    } catch (e) {
      next(e);
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
        const nextDepartment =
          p.data.departmentId === undefined
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
    try {
      const schema = z
        .object({
          name: z.string().min(2).max(120).optional(),
          description: z.string().max(1000).optional(),
          annualEntitlement: z.number().min(0).max(366).optional(),
          balancePolicy: z.enum(["shared", "separate", "none"]).optional(),
          workflow: z.enum(["hod", "both"]).optional(),
          template: z.enum(["letter", "application", "both"]).optional(),
          active: z.boolean().optional(),
        })
        .strict();
      const p = schema.safeParse(req.body);
      if (!p.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          p.error.issues.map((i) => i.message).join("; "),
        );
      const type = await LeaveType.findById(req.params.id);
      if (!type)
        throw new HttpError(404, "NOT_FOUND", "Leave category not found.");
      const before = type.toObject();
      Object.assign(type, p.data);
      type.policyVersion += 1;
      await type.save();
      await LeavePolicy.create({
        leaveTypeId: type._id,
        version: type.policyVersion,
        annualEntitlement: type.annualEntitlement,
        accountingPeriod: "calendar-year",
        effectiveFrom: new Date(),
        carryForward: false,
        createdBy: req.user._id,
        notes:
          "Created by policy configuration update; verify institutional approval.",
      });
      await AuditLog.create({
        actorId: req.user._id,
        action: "leave-policy.updated",
        entityType: "LeaveType",
        entityId: String(type._id),
        requestId: req.requestId,
        before: {
          annualEntitlement: before.annualEntitlement,
          workflow: before.workflow,
          active: before.active,
        },
        after: {
          annualEntitlement: type.annualEntitlement,
          workflow: type.workflow,
          active: type.active,
          policyVersion: type.policyVersion,
        },
      });
      res.json({ data: type });
    } catch (e) {
      next(e);
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
        delta: z.number().min(-366).max(366),
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
    const year = Number(req.body?.year) || calendarYear(new Date());
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
// Also surface legacy/inconsistent approvals that have no matching user so an
// administrator can repair them without editing MongoDB documents manually.
router.get(
  "/admin/access-requests",
  requireAuth,
  requireRole("admin"),
  async (_req, res, next) => {
    try {
      const [pending, approved, departments] = await Promise.all([
        AccessRequest.find({ status: "pending" })
          .select("name email status createdAt userId reviewedAt reviewedBy")
          .sort({ createdAt: 1 })
          .lean(),
        AccessRequest.find({ status: "approved" })
          .select("name email status createdAt userId reviewedAt reviewedBy")
          .sort({ createdAt: 1 })
          .lean(),
        Department.find({ active: true })
          .select("_id name code")
          .sort({ name: 1 })
          .lean(),
      ]);

      const repairable = [];
      for (const request of approved) {
        const user = await User.findOne({ email: request.email })
          .select("_id")
          .lean();
        if (!user) {
          repairable.push({ ...request, needsRepair: true, repairAction: "reopen" });
        } else if (String(request.userId || "") !== String(user._id)) {
          repairable.push({ ...request, needsRepair: true, repairAction: "reconcile" });
        }
      }

      res.json({
        data: [
          ...pending.map((request) => ({ ...request, needsRepair: false })),
          ...repairable,
        ],
        departments,
      });
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
      z.object({ action: z.literal("reopen") }),
      z.object({ action: z.literal("reconcile") }),
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
        const before = { status: request.status, userId: request.userId ? String(request.userId) : null };

        if (parsed.data.action === "reopen") {
          if (request.status !== "approved") {
            throw new HttpError(409, "REQUEST_NOT_REPAIRABLE", "Only an inconsistent approved request can be reopened.");
          }
          const existingUser = await User.findOne({ email: request.email }).session(dbSession);
          if (existingUser) {
            throw new HttpError(409, "USER_ALREADY_EXISTS", "A user record exists for this email. Reconcile the request instead of reopening it.");
          }
          request.status = "pending";
          request.userId = null;
          request.reviewedBy = null;
          request.reviewedAt = null;
          request.rejectionReason = "";
          await request.save({ session: dbSession });
          await AuditLog.create([{
            actorId: req.user._id,
            action: "access-request.reopened-for-repair",
            entityType: "AccessRequest",
            entityId: String(request._id),
            requestId: req.requestId,
            before,
            after: { status: "pending", userId: null },
          }], { session: dbSession });
          output = { id: request._id, status: request.status, repaired: true };
          return;
        }

        if (parsed.data.action === "reconcile") {
          if (request.status !== "approved") {
            throw new HttpError(409, "REQUEST_NOT_REPAIRABLE", "Only an approved request can be reconciled.");
          }
          const existingUser = await User.findOne({ email: request.email }).session(dbSession);
          if (!existingUser) {
            throw new HttpError(409, "USER_NOT_FOUND", "No matching user exists. Reopen the request for approval instead.");
          }
          if (!existingUser.active || !existingUser.provisioned) {
            throw new HttpError(409, "USER_NOT_AUTHORIZED", "The matching user is inactive or not provisioned. Fix the user account before reconciling this request.");
          }
          if (existingUser.googleSub && existingUser.googleSub !== request.googleSub) {
            throw new HttpError(409, "GOOGLE_IDENTITY_MISMATCH", "The existing user is linked to a different Google identity.");
          }
          if (!existingUser.googleSub) {
            existingUser.googleSub = request.googleSub;
            await existingUser.save({ session: dbSession });
          }
          request.userId = existingUser._id;
          await request.save({ session: dbSession });
          await AuditLog.create([{
            actorId: req.user._id,
            action: "access-request.reconciled",
            entityType: "AccessRequest",
            entityId: String(request._id),
            requestId: req.requestId,
            before,
            after: { status: request.status, userId: String(existingUser._id) },
          }], { session: dbSession });
          output = { id: request._id, status: request.status, userId: existingUser._id, repaired: true };
          return;
        }

        if (request.status !== "pending") throw new HttpError(409, "REQUEST_ALREADY_REVIEWED", "This access request has already been reviewed.");

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

