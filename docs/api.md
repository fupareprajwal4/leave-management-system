# API notes

Base path: `/api/v1`. JSON errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/auth/google` | Public | Start configured Google OAuth |
| GET | `/auth/me` | Signed in | Current provisioned user |
| POST | `/auth/logout` | Signed in/session | Destroy session |
| GET | `/departments` | Public | Active department records / initial list |
| GET | `/faculty/dashboard` | Faculty | Dashboard summary data |
| GET | `/faculty/leave-balances?year=2026` | Faculty | Own balances |
| GET | `/faculty/leave-applications` | Faculty | Own paginated application list |
| POST | `/faculty/leave-applications` | Faculty | Create a draft |
| POST | `/faculty/leave-applications/:id/submit` | Owner | Submit a draft/returned request |
| POST | `/faculty/leave-applications/:id/withdraw` | Owner | Withdraw eligible request |
| GET | `/hod/dashboard` | HOD | Assigned department counts |
| GET | `/hod/leave-applications` | HOD | Assigned department requests |
| POST | `/hod/leave-applications/:id/approve` | Assigned HOD | Approve/forward |
| POST | `/hod/leave-applications/:id/reject` | Assigned HOD | Reject |
| POST | `/hod/leave-applications/:id/return` | Assigned HOD | Return for correction |
| GET | `/admin/dashboard` | Admin | Institute metrics |
| GET | `/admin/leave-applications` | Admin | Institute-wide queue |
| POST | `/admin/leave-applications/:id/approve` | Admin | Final approval |
| POST | `/admin/leave-applications/:id/reject` | Admin | Final rejection |
| POST | `/admin/leave-applications/:id/return` | Admin | Return for correction |
| POST | `/admin/leave-balances/initialize-year` | Admin | Idempotent annual initialization |
| GET | `/admin/audit-logs` | Admin | Paginated audit records |
| GET | `/admin/reports/leave-utilization?year=2026` | Admin | Utilization aggregation |
