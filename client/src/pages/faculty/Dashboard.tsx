import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FilePlus2,
  FileText,
  WalletCards,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import StatCard from '../../components/StatCard';
import StatusPill from '../../components/StatusPill';
import { api } from '../../services/api';

export default function FacultyDashboard() {
  const navigate = useNavigate();

  const [data, setData] = useState<any>({
    applications: [],
    balances: [],
  });

  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const load = () => {
      void api
        .get('/faculty/dashboard')
        .then((response) => {
          if (active) {
            setData(
              response.data.data || {
                applications: [],
                balances: [],
              },
            );
            setError('');
          }
        })
        .catch((e: any) => {
          if (active) {
            setError(
              e.response?.data?.error?.message ||
                'Unable to load your dashboard.',
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

  const balances = data.balances || [];
  const apps = data.applications || [];

  const sum = (key: string) =>
    balances.reduce(
      (total: number, balance: any) =>
        total + (Number(balance[key]) || 0),
      0,
    );

  const pending = apps.filter((application: any) =>
    [
      'Pending HOD',
      'Pending Admin',
      'Returned by HOD',
      'Returned by Admin',
    ].includes(application.status),
  ).length;

  const date = (value: string) =>
    new Date(value).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

  return (
    <>
      <SectionHeading
        eyebrow="FACULTY OVERVIEW"
        title="Your leave overview"
        description="Your live leave balance, applications and approval status."
        action={
          <button
            className="btn btn-primary"
            onClick={() => navigate('/faculty/new')}
          >
            <FilePlus2 size={17} />
            New application
          </button>
        }
      />

      {error && (
        <div className="error-banner">{error}</div>
      )}

      <div className="welcome-banner">
        <div>
          <span className="banner-kicker">
            YOUR LEAVE AT A GLANCE
          </span>

          <h2>Plan time away with confidence.</h2>

          <p>
            Keep track of your balance and follow each request
            through the approval process.
          </p>

          <button
            className="btn btn-white"
            onClick={() => navigate('/faculty/balances')}
          >
            View leave balances
            <ArrowUpRight size={16} />
          </button>
        </div>

        <div className="banner-art">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />

          <div className="art-calendar">
            <CalendarDays size={32} />
            <b>{new Date().getFullYear()}</b>
            <small>Leave planner</small>
          </div>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Assigned entitlement"
          value={`${sum('assignedEntitlement')} days`}
          detail={`Calendar year ${new Date().getFullYear()}`}
          icon={<WalletCards />}
        />

        <StatCard
          label="Leave consumed"
          value={`${sum('consumedDays')} days`}
          detail="Final approved leave"
          icon={<CheckCircle2 />}
          tone="green"
        />

        <StatCard
          label="Available balance"
          value={`${sum('availableBalance')} days`}
          detail="After pending reservations"
          icon={<CalendarDays />}
          tone="violet"
        />

        <StatCard
          label="In review"
          value={`${pending} requests`}
          detail="Awaiting a workflow action"
          icon={<Clock3 />}
          tone="amber"
        />
      </div>

      <div className="content-grid">
        <section className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <h3>Recent applications</h3>
              <p>Latest records from your account</p>
            </div>

            <button
              className="text-button"
              onClick={() =>
                navigate('/faculty/applications')
              }
            >
              View all
              <ArrowUpRight size={15} />
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Leave & dates</th>
                  <th>Days</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {apps.slice(0, 5).map((application: any) => (
                  <tr key={application._id}>
                    <td>
                      <b className="ref-code">
                        {application.reference}
                      </b>

                      <small className="table-sub">
                        {date(application.createdAt)}
                      </small>
                    </td>

                    <td>
                      <b>
                        {application.leaveTypeId?.name ||
                          'Leave'}
                      </b>

                      <small className="table-sub">
                        {date(application.startDate)} –{' '}
                        {date(application.endDate)}
                      </small>
                    </td>

                    <td>{application.requestedDays}</td>

                    <td>
                      <StatusPill
                        status={application.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {apps.length === 0 && (
              <div className="empty-state">
                No applications yet. Create your first leave
                request when ready.
              </div>
            )}
          </div>
        </section>

        <section className="panel process-panel">
          <div className="panel-heading">
            <div>
              <h3>How approvals work</h3>
              <p>
                Each decision is recorded in your application
                history.
              </p>
            </div>
          </div>

          <div className="process-step">
            <span className="step-number done">1</span>
            <div>
              <b>Submit application</b>
              <p>Enter dates, leave type and reason.</p>
            </div>
          </div>

          <div className="process-line" />

          <div className="process-step">
            <span className="step-number current">2</span>
            <div>
              <b>HOD review</b>
              <p>Department reviews the request.</p>
            </div>
          </div>

          <div className="process-line" />

          <div className="process-step">
            <span className="step-number">3</span>
            <div>
              <b>Establishment review</b>
              <p>Required for configured categories.</p>
            </div>
          </div>

          <div className="process-line" />

          <div className="process-step">
            <span className="step-number">4</span>
            <div>
              <b>Final decision</b>
              <p>Download or print the saved record.</p>
            </div>
          </div>
        </section>
      </div>

      <div className="info-note">
        <FileText size={17} />
        <span>
          Your entitlement is provisioned automatically from
          the active institutional policy. Your balance and
          usage are tracked separately from every other
          faculty member.
        </span>
      </div>
    </>
  );
}