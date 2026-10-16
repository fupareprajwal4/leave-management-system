
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Save,
  WalletCards,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import { api } from '../../services/api';

type Employee = {
  _id: string;
  name: string;
  email: string;
  role: 'faculty' | 'hod' | 'admin';
  active: boolean;
  provisioned: boolean;
  departmentId?: { name?: string; code?: string } | null;
};

type LeaveType = {
  _id: string;
  name: string;
  abbreviation: string;
  annualEntitlement?: number;
  balancePolicy?: 'separate' | 'shared' | 'none';
  active: boolean;
};

type Balance = {
  _id: string;
  employeeId: any;
  leaveTypeId: any;
  year: number;
  openingBalance: number;
  assignedEntitlement?: number;
  assignedDays: number | null;
  individuallyAssigned: boolean;
  consumedDays: number;
  reservedDays: number;
  remainingBalance: number;
  availableBalance?: number;
};

export default function AdminLeaveBalances() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [balances, setBalances] = useState<Balance[]>([]);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const eligibleTypes = useMemo(
    () =>
      types.filter(
        (type) =>
          type.active &&
          type.balancePolicy !== 'none' &&
          type.balancePolicy !== 'shared',
      ),
    [types],
  );

  const selectedEmployee = employees.find(
    (employee) => employee._id === employeeId,
  );
  const selectedType = eligibleTypes.find(
    (type) => type._id === leaveTypeId,
  );
  const selectedBalance = balances.find(
    (balance) =>
      String(balance.leaveTypeId?._id || balance.leaveTypeId) === leaveTypeId,
  );
  const assigned = Boolean(selectedBalance?.individuallyAssigned);

  async function loadPeopleAndTypes() {
    setError('');

    try {
      const [userResponse, typeResponse] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/leave-types'),
      ]);

      const people = (userResponse.data.data || []).filter(
        (user: Employee) =>
          ['faculty', 'hod'].includes(user.role) &&
          user.active &&
          user.provisioned,
      );

      const leaveTypes = typeResponse.data.data || [];

      setEmployees(people);
      setTypes(leaveTypes);

      setEmployeeId((current) => current || people[0]?._id || '');

      setLeaveTypeId(
        (current) =>
          current ||
          leaveTypes.find(
            (type: LeaveType) =>
              type.active &&
              type.abbreviation === 'CL' &&
              type.balancePolicy !== 'none' &&
              type.balancePolicy !== 'shared',
          )?._id ||
          leaveTypes.find(
            (type: LeaveType) =>
              type.active &&
              type.balancePolicy !== 'none' &&
              type.balancePolicy !== 'shared',
          )?._id ||
          '',
      );
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to load faculty and leave categories.',
      );
    }
  }

  async function loadBalances() {
    if (!employeeId || !year) {
      setBalances([]);
      return;
    }

    setLoading(true);
    setError('');
    setBalances([]);

    try {
      const response = await api.get('/admin/leave-balances', {
        params: { employeeId, year: Number(year) },
      });

      setBalances(response.data.data || []);
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to load this faculty member’s balances.',
      );
      setBalances([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPeopleAndTypes();
  }, []);

  useEffect(() => {
    void loadBalances();
  }, [employeeId, year]);

  useEffect(() => {
    if (!leaveTypeId) return;

    const balance = balances.find(
      (row) =>
        String(row.leaveTypeId?._id || row.leaveTypeId) === leaveTypeId,
    );

    setDays(
      balance?.individuallyAssigned
        ? String(balance.assignedDays ?? balance.assignedEntitlement ?? '')
        : '',
    );
    setReason('');
  }, [leaveTypeId, balances]);

  async function assign(e: React.FormEvent) {
    e.preventDefault();

    if (!employeeId || !leaveTypeId || days.trim() === '' || !reason.trim()) {
      setError(
        'Select a faculty member and leave category, enter the assigned days, and provide a reason.',
      );
      return;
    }

    const numericDays = Number(days);

    if (
      !Number.isFinite(numericDays) ||
      numericDays < 0 ||
      numericDays > 366
    ) {
      setError('Assigned days must be between 0 and 366.');
      return;
    }

    if (
      selectedBalance?.individuallyAssigned &&
      !window.confirm(
        `Update ${selectedEmployee?.name}’s ${selectedType?.name} entitlement for ${year}? The difference will be recorded as an audited balance adjustment.`,
      )
    ) {
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');

    try {
      await api.post(
        `/admin/faculty/${employeeId}/leave-entitlements`,
        {
          leaveTypeId,
          year: Number(year),
          days: numericDays,
          reason: reason.trim(),
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );

      setMessage(
        `${selectedType?.name} entitlement saved for ${selectedEmployee?.name} (${year}).`,
      );
      setReason('');
      await loadBalances();
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to assign this individual entitlement.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionHeading
        eyebrow="INDIVIDUAL ACCOUNTING"
        title="Faculty leave balances"
        description="Assign and maintain a separate annual entitlement for each faculty member and leave category. Reference policy quotas are never granted automatically."
        action={
          <button
            className="btn btn-quiet"
            onClick={() => void loadBalances()}
            disabled={loading}
          >
            <RefreshCw size={16} /> Refresh
          </button>
        }
      />

      <div className="admin-alert">
        <div className="alert-icon warning">
          <AlertTriangle size={20} />
        </div>
        <div>
          <b>Individual assignment is required</b>
          <p>
            Legacy balances created by the old global initializer are marked
            unassigned until an administrator confirms the correct entitlement
            for each person. Reducing an entitlement cannot make the remaining
            balance negative or consume days already reserved by applications.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {message && (
        <div className="success-banner">
          <CheckCircle2 size={16} /> {message}
        </div>
      )}

      <section className="panel policy-editor" style={{ marginBottom: 20 }}>
        <div className="panel-heading">
          <div>
            <h3>
              <WalletCards size={18} /> Assign individual entitlement
            </h3>
            <p>
              Each assignment is saved for one employee, one leave category and
              one calendar year.
            </p>
          </div>
        </div>

        <form onSubmit={assign}>
          <div className="form-grid">
            <label>
              Faculty / HOD *
              <select
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                required
              >
                <option value="">Select employee</option>
                {employees.map((employee) => (
                  <option key={employee._id} value={employee._id}>
                    {employee.name} · {employee.email} (
                    {employee.role.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            <label>
              Calendar year *
              <input
                type="number"
                min="2000"
                max="2200"
                value={year}
                onChange={(event) => setYear(event.target.value)}
                required
              />
            </label>

            <label>
              Leave category *
              <select
                value={leaveTypeId}
                onChange={(event) => setLeaveTypeId(event.target.value)}
                required
              >
                <option value="">Select leave category</option>
                {eligibleTypes.map((type) => (
                  <option key={type._id} value={type._id}>
                    {type.name} ({type.abbreviation})
                  </option>
                ))}
              </select>
            </label>

            <label>
              Assigned days *
              <input
                type="number"
                min="0"
                max="366"
                step="1"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                placeholder="Enter this person's quota"
                required
              />
            </label>

            <label className="full-field">
              Reason / authorization reference *
              <textarea
                rows={2}
                minLength={5}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Approved annual entitlement per Establishment order ..."
                required
              />
            </label>
          </div>

          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={
                saving || !employees.length || !eligibleTypes.length
              }
            >
              <Save size={16} />{' '}
              {saving
                ? 'Saving…'
                : assigned
                  ? 'Update individual entitlement'
                  : 'Assign individual entitlement'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h3>
              {selectedEmployee
                ? `${selectedEmployee.name} · ${year}`
                : 'Selected employee balance'}
            </h3>
            <p>
              Only an explicit individual assignment is considered an available
              entitlement.
            </p>
          </div>
          <span className="count-chip">{eligibleTypes.length} categories</span>
        </div>

        {loading ? (
          <div className="empty-state">Loading balances…</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leave category</th>
                  <th>Assigned entitlement</th>
                  <th>Consumed</th>
                  <th>Reserved</th>
                  <th>Available</th>
                  <th>Assignment</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {eligibleTypes.map((type) => {
                  const balance = balances.find(
                    (row) =>
                      String(row.leaveTypeId?._id || row.leaveTypeId) ===
                      type._id,
                  );
                  const isAssigned = Boolean(balance?.individuallyAssigned);

                  return (
                    <tr key={type._id}>
                      <td>
                        <b>{type.name}</b>
                        <small className="table-sub">{type.abbreviation}</small>
                      </td>

                      <td>
                        {isAssigned
                          ? `${balance?.assignedDays ?? balance?.assignedEntitlement ?? balance?.openingBalance ?? 0} days`
                          : balance
                            ? `Unassigned · legacy opening ${balance.openingBalance ?? 0}`
                            : 'Not created'}
                      </td>

                      <td>
                        {balance ? `${balance.consumedDays ?? 0} days` : '—'}
                      </td>

                      <td>
                        {balance ? `${balance.reservedDays ?? 0} days` : '—'}
                      </td>

                      <td>
                        {balance
                          ? `${balance.availableBalance ?? Math.max(0, Number(balance.remainingBalance ?? 0) - Number(balance.reservedDays ?? 0))} days${isAssigned ? '' : ' · legacy'}`
                          : '—'}
                      </td>

                      <td>
                        <span
                          className={`status-pill ${isAssigned ? 'approved' : 'pending-hod'}`}
                        >
                          {isAssigned ? 'Assigned' : 'Not assigned'}
                        </span>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          onClick={() => {
                            setLeaveTypeId(type._id);
                            setDays(
                              isAssigned
                                ? String(
                                    balance?.assignedDays ??
                                      balance?.assignedEntitlement ??
                                      balance?.openingBalance ??
                                      '',
                                  )
                                : '',
                            );
                            setReason('');
                          }}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {!employees.length && (
              <div className="empty-state">
                No active provisioned faculty or HOD accounts were found.
              </div>
            )}

            {employees.length > 0 && !eligibleTypes.length && (
              <div className="empty-state">
                No active leave categories use individual balances.
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
