import { useEffect, useState } from 'react';
import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api } from '../../services/api';

type AccessRequest = {
  _id: string;
  name: string;
  email: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt?: string;
  needsRepair?: boolean;
  repairAction?: 'reopen' | 'reconcile';
};

type Department = { _id: string; name: string; code: string };
type Role = 'faculty' | 'hod' | 'admin';
type Assignment = { role: Role; departmentId: string; designation: string };

export default function AccessRequests() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadRequests() {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/access-requests');
      const incoming: AccessRequest[] = response.data.data || [];
      setRequests(incoming);
      setDepartments(response.data.departments || []);
      setAssignments((previous) => {
        const next = { ...previous };
        for (const request of incoming) {
          if (!next[request._id]) {
            next[request._id] = { role: 'faculty', departmentId: '', designation: '' };
          }
        }
        return next;
      });
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Could not load access requests. Sign in with an administrator account and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadRequests(); }, []);

  function updateAssignment(id: string, changes: Partial<Assignment>) {
    setAssignments((previous) => ({
      ...previous,
      [id]: Object.assign(
        { role: 'faculty' as Role, departmentId: '', designation: '' },
        previous[id],
        changes,
      ),
    }));
  }

  async function approve(request: AccessRequest) {
    const assignment = assignments[request._id] || { role: 'faculty' as Role, departmentId: '', designation: '' };
    if (assignment.role !== 'admin' && !assignment.departmentId) {
      setError('Choose a department for a Faculty or HOD account.');
      return;
    }
    if (!window.confirm(`Approve ${request.email} as ${assignment.role.toUpperCase()}?`)) return;
    setBusyId(request._id); setError(''); setMessage('');
    try {
      await api.patch(`/admin/access-requests/${request._id}`, {
        action: 'approve', role: assignment.role,
        departmentId: assignment.role === 'admin' ? null : assignment.departmentId,
        designation: assignment.designation,
      });
      setMessage(`Access approved for ${request.email}. They can now sign in with the same Google account.`);
      await loadRequests();
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Approval failed. Please refresh and try again.');
    } finally { setBusyId(null); }
  }

  async function repair(request: AccessRequest) {
    const action = request.repairAction;
    if (!action) return;
    const isReopen = action === 'reopen';
    const prompt = isReopen
      ? `No matching user account exists for ${request.email}. Reopen this inconsistent approved request so it can be reviewed again?`
      : `A matching user exists for ${request.email}, but the request is not linked to it. Reconcile the request record?`;
    if (!window.confirm(prompt)) return;
    setBusyId(request._id); setError(''); setMessage('');
    try {
      await api.patch(`/admin/access-requests/${request._id}`, { action });
      setMessage(isReopen
        ? `The inconsistent request for ${request.email} has been reopened. Review and approve it normally.`
        : `The request for ${request.email} has been linked to the existing user account.`);
      await loadRequests();
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Request repair failed. Refresh and try again.');
    } finally { setBusyId(null); }
  }

  async function reject(request: AccessRequest) {
    const reason = window.prompt(`Optional reason for rejecting ${request.email}:`);
    if (reason === null) return;
    if (!window.confirm(`Reject the access request from ${request.email}?`)) return;
    setBusyId(request._id); setError(''); setMessage('');
    try {
      await api.patch(`/admin/access-requests/${request._id}`, { action: 'reject', reason });
      setMessage(`Access request rejected for ${request.email}.`);
      await loadRequests();
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Rejection failed. Please refresh and try again.');
    } finally { setBusyId(null); }
  }

  return (
    <div>
      <div className="section-heading">
        <div>
          <div className="eyebrow">ACCOUNT GOVERNANCE</div>
          <h1>Access requests</h1>
          <p>Review first-time Google sign-ins and assign approved roles.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => void loadRequests()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="panel" role="alert" style={{ borderColor: '#f1c4c4', color: '#a52c2c', marginBottom: 16 }}>{error}</div>}
      {message && <div className="panel" role="status" style={{ borderColor: '#bde8d5', color: '#216b50', marginBottom: 16 }}>{message}</div>}

      {loading ? <div className="panel"><p>Loading access requests…</p></div> : requests.length === 0 ? (
        <div className="panel">
          <div className="panel-heading"><h3><ShieldCheck size={18} /> No pending requests</h3></div>
          <p>New users will appear here after they verify their Google account and request access.</p>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-heading">
            <div><h3><ShieldCheck size={18} /> Pending registrations</h3><p>{requests.length} pending request{requests.length === 1 ? '' : 's'} or inconsistent records requiring repair</p></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Applicant</th><th>Status</th><th>Role to assign</th><th>Department</th><th>Designation</th><th>Decision / repair</th></tr></thead>
              <tbody>
                {requests.map((request) => {
                  const assignment = assignments[request._id] || { role: 'faculty' as Role, departmentId: '', designation: '' };
                  return <tr key={request._id}>
                    <td><b>{request.name}</b><span className="table-sub">{request.email}</span><span className="table-sub">Requested {request.createdAt ? new Date(request.createdAt).toLocaleDateString('en-IN') : 'recently'}</span></td>
                    <td>{request.needsRepair ? <span className="status-pill pending-admin">Approved · inconsistent</span> : <span className={`status-pill ${request.status}`}>{request.status}</span>}</td>
                    <td>{request.needsRepair ? <span className="table-sub">Repair the request record first</span> : <select aria-label={`Role for ${request.email}`} value={assignment.role} onChange={(event) => updateAssignment(request._id, { role: event.target.value as Role, departmentId: event.target.value === 'admin' ? '' : assignment.departmentId })}>
                      <option value="faculty">Faculty</option><option value="hod">HOD</option><option value="admin">Administrator</option>
                    </select>}</td>
                    <td>{request.needsRepair ? <span className="table-sub">Not applicable</span> : <select aria-label={`Department for ${request.email}`} value={assignment.departmentId} disabled={assignment.role === 'admin'} onChange={(event) => updateAssignment(request._id, { departmentId: event.target.value })}>
                      <option value="">Select department</option>{departments.map((department) => <option key={department._id} value={department._id}>{department.name} ({department.code})</option>)}
                    </select>}</td>
                    <td>{request.needsRepair ? <span className="table-sub">Not applicable</span> : <input aria-label={`Designation for ${request.email}`} value={assignment.designation} maxLength={120} placeholder="e.g. Assistant Professor" onChange={(event) => updateAssignment(request._id, { designation: event.target.value })} />}</td>
                    <td><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {request.needsRepair ? <button className="btn btn-secondary btn-small" disabled={busyId !== null || loading} onClick={() => void repair(request)}>{request.repairAction === 'reconcile' ? 'Link existing user' : 'Reopen request'}</button> : <>
                        <button className="btn btn-primary btn-small" disabled={busyId !== null || loading} onClick={() => void approve(request)}><Check size={14} /> Approve</button>
                        <button className="btn btn-danger btn-small" disabled={busyId !== null || loading} onClick={() => void reject(request)}><X size={14} /> Reject</button>
                      </>}
                    </div></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
