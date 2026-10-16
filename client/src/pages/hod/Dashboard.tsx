import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CheckCheck,
  Clock3,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import SectionHeading from '../../components/SectionHeading';
import StatCard from '../../components/StatCard';
import StatusPill from '../../components/StatusPill';
import { api } from '../../services/api';

export default function HodDashboard() {
  const navigate = useNavigate();

  const [stats, setStats] = useState<any>({
    pending: 0,
    total: 0,
  });

  const [pending, setPending] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const load = () => {
      void Promise.all([
        api.get('/hod/dashboard'),
        api.get('/hod/leave-applications', {
          params: { status: 'Pending HOD' },
        }),
        api.get('/faculty/leave-balances', {
          params: {
            year: new Date().getFullYear(),
          },
        }),
      ])
        .then(([statsResponse, pendingResponse, balanceResponse]) => {
          if (!active) return;

          setStats(statsResponse.data.data || {});
          setPending(pendingResponse.data.data || []);
          setBalances(balanceResponse.data.data || []);
          setError('');
        })
        .catch((e: any) => {
          if (active) {
            setError(
              e.response?.data?.error?.message ||
                'Unable to load department dashboard.',
            );
          }
        });
    };

    load();

    const timer = window.setInterval(load, 60_000);
    window.addEventListener('focus', load);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);

  const sum = (key: string) =>
    balances.reduce(
      (total: number, balance: any) =>
        total + (Number(balance[key]) || 0),
      0,
    );

  const date = (value: string) =>
    new Date(value).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

  return (
    <>
      <SectionHeading
        eyebrow="DEPARTMENT WORKSPACE"
        title="HOD overview"
        description="Review real leave requests for your assigned department."
        action={
          <button
            className="btn btn-primary"
            onClick={() => navigate('/hod/requests')}
          >
            Open review queue
            <ArrowRight size={16} />
          </button>
        }
      />

      {error && (
        <div className="error-banner">{error}</div>
      )}

      <div className="stats-grid">
        <StatCard
          label="Pending review"
          value={String(stats.pending || 0)}
          detail="Needs your decision"
          icon={<Clock3 />}
          tone="amber"
        />

        <StatCard
          label="Department applications"
          value={String(stats.total || 0)}
          detail="All statuses"
          icon={<CheckCheck />}
          tone="green"
        />

        <StatCard
          label="My assigned entitlement"
          value={`${sum('assignedEntitlement')} days`}
          detail={`Calendar year ${new Date().getFullYear()}`}
          icon={<CalendarDays />}
          tone="violet"
        />

        <StatCard
          label="My available leave"
          value={`${sum('availableBalance')} days`}
          detail="After pending reservations"
          icon={<Users />}
        />

        <StatCard
          label="Department faculty"
          value="—"
          detail="See faculty directory"
          icon={<Users />}
        />

        <StatCard
          label="Upcoming leave"
          value="—"
          detail="Requires approved leave date query"
          icon={<CalendarDays />}
          tone="violet"
        />
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Requests needing attention</h3>
            <p>
              Only requests assigned to your department appear
              here.
            </p>
          </div>

          <span className="count-chip">
            {pending.length} pending
          </span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee / reference</th>
                <th>Leave period</th>
                <th>Days</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>

            <tbody>
              {pending.map((request: any) => (
                <tr key={request._id}>
                  <td>
                    <b>
                      {request.employeeId?.name || 'Faculty'}
                    </b>

                    <small className="table-sub">
                      {request.reference}
                    </small>
                  </td>

                  <td>
                    <b>
                      {request.leaveTypeId?.name || 'Leave'}
                    </b>

                    <small className="table-sub">
                      {date(request.startDate)} –{' '}
                      {date(request.endDate)}
                    </small>
                  </td>

                  <td>{request.requestedDays}</td>

                  <td>
                    <StatusPill status={request.status} />
                  </td>

                  <td>
                    <button
                      className="btn btn-small btn-secondary"
                      onClick={() =>
                        navigate('/hod/requests')
                      }
                    >
                      Review
                      <ArrowRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {pending.length === 0 && (
            <div className="empty-state">
              No requests currently need your decision.
            </div>
          )}
        </div>
      </section>
    </>
  );
}