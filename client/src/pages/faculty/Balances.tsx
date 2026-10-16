import { useEffect, useState } from 'react';
import {
  CalendarDays,
  CircleHelp,
  History,
  WalletCards,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import StatCard from '../../components/StatCard';
import { api } from '../../services/api';

export default function Balances() {
  const [balances, setBalances] = useState<any[]>([]);
  const [error, setError] = useState('');

  const year = new Date().getFullYear();

  useEffect(() => {
    let active = true;

    const load = () => {
      void api
        .get('/faculty/leave-balances', {
          params: { year },
        })
        .then((response) => {
          if (active) {
            setBalances(response.data.data || []);
            setError('');
          }
        })
        .catch((e: any) => {
          if (active) {
            setError(
              e.response?.data?.error?.message ||
                'Unable to load leave balances.',
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
  }, [year]);

  const sum = (key: string) =>
    balances.reduce(
      (total, balance) =>
        total + (Number(balance[key]) || 0),
      0,
    );

  return (
    <>
      <SectionHeading
        eyebrow="LEAVE ACCOUNTING"
        title="Leave balances"
        description="Current-year balance from your institutional leave ledger."
        action={
          <button
            className="btn btn-quiet"
            onClick={() => window.print()}
          >
            <History size={16} />
            Print statement
          </button>
        }
      />

      {error && (
        <div className="error-banner">{error}</div>
      )}

      <div className="stats-grid">
        <StatCard
          label="Assigned entitlement"
          value={`${sum('assignedEntitlement')} days`}
          detail={`Policy-based · ${year}`}
          icon={<WalletCards />}
        />

        <StatCard
          label="Consumed"
          value={`${sum('consumedDays')} days`}
          detail="Final approved leave"
          icon={<CalendarDays />}
          tone="green"
        />

        <StatCard
          label="Reserved"
          value={`${sum('reservedDays')} days`}
          detail="Days held by applications under review"
          icon={<History />}
          tone="amber"
        />

        <StatCard
          label="Available"
          value={`${sum('availableBalance')} days`}
          detail="After pending reservations"
          icon={<CircleHelp />}
          tone="violet"
        />
      </div>

      <section className="panel balance-panel">
        <div className="panel-heading">
          <div>
            <h3>{year} leave balance summary</h3>
            <p>
              Values are loaded from your account, not sample
              records.
            </p>
          </div>

          <span className="year-chip">{year}</span>
        </div>

        {balances.map((balance) => {
          const leaveType = balance.leaveTypeId || {};

          const opening =
            Number(
              balance.assignedEntitlement ??
                balance.openingBalance,
            ) || 0;

          const remaining =
            Number(
              balance.availableBalance ??
                (Number(balance.remainingBalance || 0) -
                  Number(balance.reservedDays || 0)),
            ) || 0;

          const percent =
            opening > 0
              ? Math.min(
                  100,
                  Math.max(0, (remaining / opening) * 100),
                )
              : 0;

          return (
            <div className="balance-row" key={balance._id}>
              <div className="balance-symbol blue">
                {leaveType.abbreviation || 'LV'}
              </div>

              <div className="balance-name">
                <b>{leaveType.name || 'Leave category'}</b>

                <small>
                  Assigned entitlement: {opening} days
                </small>

                <div className="balance-bar">
                  <span style={{ width: `${percent}%` }} />
                </div>
              </div>

              <div className="balance-metric">
                <small>Consumed</small>
                <b>{balance.consumedDays || 0} d</b>
              </div>

              <div className="balance-metric">
                <small>Reserved</small>
                <b>{balance.reservedDays || 0} d</b>
              </div>

              <div className="balance-remaining">
                <b>{remaining}</b>
                <small>available</small>
              </div>
            </div>
          );
        })}

        {balances.length === 0 && !error && (
          <div className="empty-state">
            Your annual balance is provisioned automatically
            from the institutional policy. Refresh the page or
            contact support if it remains unavailable.
          </div>
        )}

        <div className="info-note">
          <CircleHelp size={17} />
          <span>
            Rejected requests do not consume leave. Balance
            changes must be recorded through auditable ledger
            transactions.
          </span>
        </div>
      </section>
    </>
  );
}