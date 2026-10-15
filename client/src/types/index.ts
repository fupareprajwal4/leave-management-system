export type Role = 'faculty' | 'hod' | 'admin';
export type LeaveStatus = 'Draft'|'Pending HOD'|'Returned by HOD'|'Pending Admin'|'Returned by Admin'|'Approved'|'Rejected by HOD'|'Rejected by Admin'|'Withdrawn'|'Cancelled';
export interface LeaveApplication { _id:string; reference:string; employeeName:string; department:string; leaveType:string; startDate:string; endDate:string; days:number; reason:string; status:LeaveStatus; submittedAt?:string; remarks?:string }
export interface SessionUser { id:string; name:string; email:string; role:Role; department?:string; designation?:string }
