
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock3,
  FileText,
  Users,
  Wallet,
  RefreshCw,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import SectionHeading from "../../components/SectionHeading";
import StatCard from "../../components/StatCard";
import { api } from "../../services/api";

type DashboardData = {
  departments?: number;
  users?: number;
  pending?: number;
  approved?: number;
};

type LeaveBalance = {
  _id: string;
  year: number;
  remainingBalance?: number;
  reservedDays?: number;
  consumedDays?: number;
  assignedEntitlement?: number;
  employeeId?: {
    _id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  leaveTypeId?: {
    name?: string;
    abbreviation?: string;
  };
};

type InitializationResult = {
  year?: number;
  facultyProcessed?: number;
  balancesCreated?: number;
  entitlementsCreated?: number;
  skipped?: number;
};

export default function AdminDashboard() {
  const nav = useNavigate();

  const [data, setData] = useState<DashboardData>({});
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [balanceError, setBalanceError] = useState("");

  const loadDashboard = useCallback(async () => {
    setError("");
    setBalanceError("");

    try {
      const response = await api.get("/admin/dashboard");
      setData(response.data.data || {});
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          "Unable to load establishment dashboard.",
      );
    }
  }, []);

  const loadBalances = useCallback(async () => {
    try {
      const response = await api.get("/admin/leave-balances", {
        params: { year },
      });

      setBalances(
        Array.isArray(response.data.data) ? response.data.data : [],
      );
    } catch (e: any) {
      setBalances([]);
      setBalanceError(
        e.response?.data?.error?.message ||
          "Unable to load leave balances. Check the backend API.",
      );
    }
  }, [year]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadDashboard(), loadBalances()]);
    setLoading(false);
  }, [loadDashboard, loadBalances]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initializeBalances = async () => {
    setInitializing(true);
    setError("");
    setSuccess("");

    try {
      const response = await api.post(
        "/admin/leave-balances/initialize-year",
        { year },
      );

      const result: InitializationResult = response.data.data || {};

      setSuccess(
        `Initialization completed for ${result.year ?? year}. ` +
          `${result.balancesCreated ?? 0} balance records created for ` +
          `${result.facultyProcessed ?? 0} eligible faculty/HOD accounts.`,
      );

      await Promise.all([loadDashboard(), loadBalances()]);
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          "Unable to initialize annual leave balances.",
      );
    } finally {
      setInitializing(false);
    }
  };

  const totalConsumed = balances.reduce(
    (total, balance) => total + Number(balance.consumedDays || 0),
    0,
  );

  const totalReserved = balances.reduce(
    (total, balance) => total + Number(balance.reservedDays || 0),
    0,
  );

  const totalAvailable = balances.reduce(
    (total, balance) =>
      total +
      Math.max(
        0,
        Number(balance.remainingBalance || 0) -
          Number(balance.reservedDays || 0),
      ),
    0,
  );

  return (
    <>
      <SectionHeading
        eyebrow="ESTABLISHMENT SECTION"
        title="Institute overview"
        description="Overview of departments, accounts, applications and annual leave balances."
        action={
          <button
            className="btn btn-primary"
            onClick={() => nav("/admin/requests")}
          >
            Review applications <ArrowRight size={16} />
          </button>
        }
      />

      {error && <div className="error-banner">{error}</div>}

      {success && (
        <div className="success-banner" role="status">
          {success}
        </div>
      )}

      <div className="stats-grid">
        <StatCard
          label="Active departments"
          value={String(data.departments ?? "—")}
          detail="Configured institute departments"
          icon={<Building2 />}
        />

        <StatCard
          label="Provisioned accounts"
          value={String(data.users ?? "—")}
          detail="Active user accounts"
          icon={<Users />}
          tone="green"
        />

        <StatCard
          label="Pending establishment"
          value={String(data.pending ?? "—")}
          detail="Awaiting admin action"
          icon={<Clock3 />}
          tone="amber"
        />

        <StatCard
          label="Approved applications"
          value={String(data.approved ?? "—")}
          detail="Final approved records"
          icon={<CheckCircle2 />}
          tone="violet"
        />
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-heading">
          <div>
            <h3>Annual leave balance overview</h3>
            <p>
              Individual faculty and HOD balances for the selected calendar
              year.
            </p>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              className="form-control"
              aria-label="Leave balance year"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {[year - 1, year, year + 1].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>

            <button
              className="btn btn-secondary"
              onClick={() => void refresh()}
              disabled={loading || initializing}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </div>

        {balanceError && (
          <div className="error-banner">{balanceError}</div>
        )}

        <div className="stats-grid">
          <StatCard
            label="Balance records"
            value={loading ? "…" : String(balances.length)}
            detail={`Individual category balances in ${year}`}
            icon={<Wallet />}
          />

          <StatCard
            label="Available days"
            value={loading ? "…" : totalAvailable.toLocaleString()}
            detail="Remaining days minus reservations"
            icon={<CheckCircle2 />}
            tone="green"
          />

          <StatCard
            label="Reserved days"
            value={loading ? "…" : totalReserved.toLocaleString()}
            detail="Days reserved by pending applications"
            icon={<Clock3 />}
            tone="amber"
          />

          <StatCard
            label="Consumed days"
            value={loading ? "…" : totalConsumed.toLocaleString()}
            detail="Recorded leave consumption"
            icon={<FileText />}
            tone="violet"
          />
        </div>

        {!loading && !balanceError && balances.length === 0 && (
          <div style={{ marginTop: 20 }}>
            <p>
              No annual leave balance records were returned for {year}.
              Initialize the year to provision missing balances from the
              configured leave policies.
            </p>

            <button
              className="btn btn-primary"
              onClick={() => void initializeBalances()}
              disabled={initializing}
            >
              {initializing
                ? "Initializing balances..."
                : `Initialize ${year} leave balances`}
            </button>
          </div>
        )}

        {!balanceError && balances.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="panel-heading">
              <div>
                <h3>Individual balances</h3>
                <p>
                  Showing up to 100 records. Open the balance management view
                  for the full list.
                </p>
              </div>

              <button
                className="btn btn-secondary"
                onClick={() => nav("/admin/reports")}
              >
                View reports <ArrowRight size={16} />
              </button>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Role</th>
                    <th>Leave category</th>
                    <th>Entitlement</th>
                    <th>Consumed</th>
                    <th>Reserved</th>
                    <th>Available</th>
                  </tr>
                </thead>

                <tbody>
                  {balances.slice(0, 100).map((balance) => {
                    const employee = balance.employeeId;
                    const leaveType = balance.leaveTypeId;
                    const available = Math.max(
                      0,
                      Number(balance.remainingBalance || 0) -
                        Number(balance.reservedDays || 0),
                    );

                    return (
                      <tr key={balance._id}>
                        <td>
                          <strong>{employee?.name || "Unknown employee"}</strong>
                          <br />
                          <small>{employee?.email || ""}</small>
                        </td>
                        <td>{employee?.role || "—"}</td>
                        <td>
                          {leaveType?.abbreviation || leaveType?.name || "—"}
                        </td>
                        <td>
                          {balance.assignedEntitlement ??
                            balance.remainingBalance ??
                            0}
                        </td>
                        <td>{balance.consumedDays ?? 0}</td>
                        <td>{balance.reservedDays ?? 0}</td>
                        <td>{available}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && balances.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button
              className="btn btn-secondary"
              onClick={() => void initializeBalances()}
              disabled={initializing}
            >
              {initializing
                ? "Checking and initializing..."
                : `Check for missing ${year} balances`}
            </button>
          </div>
        )}
      </section>

      <div className="content-grid" style={{ marginTop: 24 }}>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>Establishment operations</h3>
              <p>Manage policies and authorized accounts.</p>
            </div>
          </div>

          <div className="admin-quick-links">
            <button
              className="btn btn-secondary"
              onClick={() => nav("/admin/faculty")}
            >
              <Users size={16} /> People & departments
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => nav("/admin/policies")}
            >
              <FileText size={16} /> Leave policies
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => nav("/admin/reports")}
            >
              <ArrowRight size={16} /> Reports & audit
            </button>
          </div>
        </section>

        <section className="panel process-panel">
          <div className="panel-heading">
            <div>
              <h3>Operational safeguards</h3>
              <p>Before institutional rollout</p>
            </div>
          </div>

          <p>
            Confirm official category entitlements and form terminology.
          </p>
          <p>
            Configure verified Google OAuth, SMTP, MongoDB Atlas and private
            attachment storage.
          </p>
          <p>
            Run integration and concurrency tests against a replica-set
            database.
          </p>
        </section>
      </div>
    </>
  );
}
