import type { Request, Response, NextFunction } from "express";
import { User, Department } from "../models/index.js";
export interface AuthRequest extends Request {
  user?: any;
  requestId?: string;
}
export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = (req.session as any)?.userId;
    if (!id)
      return res
        .status(401)
        .json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Sign in with an authorized institutional account.",
          },
        });
    const user = await User.findById(id).lean();
    if (!user || !user.active || !user.provisioned)
      return res
        .status(403)
        .json({
          error: {
            code: "ACCOUNT_NOT_AUTHORIZED",
            message: "This account is not active or provisioned.",
          },
        });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role))
      return res
        .status(403)
        .json({
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission for this action.",
          },
        });
    next();
  };
}
export function requireDepartmentScope(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.user?.role === "admin") return next();
  if (req.user?.role !== "hod")
    return res
      .status(403)
      .json({ error: { code: "FORBIDDEN", message: "HOD role required." } });
  req.query.departmentId = String(req.user.departmentId || "");
  next();
}

export async function requireAssignedHod(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.user || req.user.role !== "hod")
      return res
        .status(403)
        .json({ error: { code: "FORBIDDEN", message: "HOD role required." } });
    const department = await Department.findById(req.user.departmentId).lean();
    if (!department || String(department.hodId) !== String(req.user._id))
      return res
        .status(403)
        .json({
          error: {
            code: "HOD_NOT_ASSIGNED",
            message:
              "This account is not the currently assigned HOD for its department.",
          },
        });
    next();
  } catch (e) {
    next(e);
  }
}
