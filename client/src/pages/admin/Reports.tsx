import { useEffect, useState, type FormEvent } from 'react';
import {
  Download,
  FileSpreadsheet,
  History,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import { api } from '../../services/api';

type UtilizationRow = {
  category?: string;
  employees?: number;
  opening?: number;
  consumed?: number;
  reserved?: number;
  available?: number;
};

export default function AdminReports() {
  const [report, setReport] = useState<UtilizationRow[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [year, setYear] = useState(
    String(new Date().getFullYear()),
  );
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void load();
  }, [year]);

  async function load() {
    setError('');
    setNotice('');

    try {
      const [
        reportResponse,
        auditResponse,
        userResponse,
      ] = await Promise.all([
        api.get('/admin/reports/leave-utilization', {
          params: { year },
        }),
        api.get('/admin/audit-logs', {
          params: { page: 1 },
        }),
        api.get('/admin/users'),
      ]);

      setReport(reportResponse.data.data || []);
      setLogs(auditResponse.data.data || []);
      setUsers(userResponse.data.data || []);
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to load reports.',
      );
    }
  }

  function csvText() {
    const headers = [
      'Year',
      'Category',
      'Employees',
      'Assigned entitlement',
      'Consumed days',
      'Reserved days',
      'Available days',
    ];

    const rows = report.map((row) => [
      year,
      row.category || '',
      row.employees || 0,
      row.opening || 0,
      row.consumed || 0,
      row.reserved || 0,
      row.available || 0,
    ]);

    return [headers, ...rows]
      .map((row) =>
        row
          .map(
            (value) =>
              `"${String(value).replaceAll('"', '""')}"`,
          )
          .join(','),
      )
      .join('\r\n');
  }

  function exportCsv() {
    const url = URL.createObjectURL(
      new Blob([csvText()], {
        type: 'text/csv;charset=utf-8',
      }),
    );

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `leave-utilization-${year}.csv`;
    anchor.click();

    URL.revokeObjectURL(url);
  }

  async function emailReport(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setError('');
    setNotice('');
    setSending(true);

    try {
      const response = await api.post(
        '/admin/reports/leave-utilization/email',
        {
          year: Number(year),
          recipient: recipient.trim(),
        },
      );

      setNotice(
        response.data.message ||
          `Report queued for ${recipient.trim()}.`,
      );
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to queue the report email. Check the recipient and try again.',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <SectionHeading
        eyebrow="REPORTING & GOVERNANCE"
        title="Reports & audit logs"
        description="Download annual utilization reports, email a CSV attachment, and review administrative activity."
        action={
          <button
            className="btn btn-primary"
            onClick={exportCsv}
            disabled={!report.length}
          >
            <Download size={16} />
            Export CSV
          </button>
        }
      />

      {error && (
        <div className="error-banner">{error}</div>
      )}

      {notice && (
        <div className="success-banner">{notice}</div>
      )}

      <div className="table-toolbar">
        <label>
          Calendar year
          <select
            value={year}
            onChange={(event) =>
              setYear(event.target.value)
            }
          >
            {[
              new Date().getFullYear(),
              new Date().getFullYear() - 1,
              new Date().getFullYear() - 2,
            ].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon blue">
            <FileSpreadsheet />
          </div>
          <div className="stat-copy">
            <span>Utilization report</span>
            <strong>{report.length} categories</strong>
            <small>Annual consumption and balance</small>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon green">
            <History />
          </div>
          <div className="stat-copy">
            <span>Audit trail</span>
            <strong>{logs.length} recent events</strong>
            <small>Approvals, policy and adjustments</small>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon violet">
            <ShieldCheck />
          </div>
          <div className="stat-copy">
            <span>Access review</span>
            <strong>{users.length} accounts</strong>
            <small>Provisioned users and assignments</small>
          </div>
        </div>
      </div>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h3>Leave utilization · {year}</h3>
            <p>
              Aggregated by leave category. The CSV includes
              assigned entitlement, consumed, reserved and
              available days.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Employees</th>
                <th>Assigned entitlement</th>
                <th>Consumed</th>
                <th>Reserved</th>
                <th>Available</th>
              </tr>
            </thead>

            <tbody>
              {report.map((row, index) => (
                <tr key={`${row.category}-${index}`}>
                  <td>
                    <b>{row.category || 'Unspecified'}</b>
                  </td>
                  <td>{row.employees || 0}</td>
                  <td>{row.opening || 0}</td>
                  <td>{row.consumed || 0}</td>
                  <td>{row.reserved || 0}</td>
                  <td>{row.available || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {!report.length && (
            <div className="empty-state">
              No annual balance data for {year}.
            </div>
          )}
        </div>
      </section>

      <section className="panel policy-editor">
        <div className="panel-heading">
          <div>
            <h3>
              <Mail size={18} />
              Email report
            </h3>
            <p>
              Queue the selected year's utilization CSV as an
              email attachment.
            </p>
          </div>
        </div>

        <form
          onSubmit={emailReport}
          className="report-email-form"
        >
          <label className="policy-label">
            Recipient email
            <input
              type="email"
              value={recipient}
              onChange={(event) =>
                setRecipient(event.target.value)
              }
              placeholder="establishment@sggs.ac.in"
              required
            />
          </label>

          <button
            className="btn btn-primary"
            type="submit"
            disabled={sending || !report.length}
          >
            <Mail size={16} />
            {sending ? 'Queueing…' : 'Email CSV report'}
          </button>
        </form>

        <div className="info-note">
          The email is queued safely and sent by the configured
          outbox worker. SMTP must be configured and the
          scheduled worker must be running for delivery.
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h3>Recent audit events</h3>
            <p>
              Chronological record of important administrative
              operations.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Actor</th>
                <th>Request ID</th>
              </tr>
            </thead>

            <tbody>
              {logs.map((log: any) => (
                <tr key={log._id}>
                  <td>
                    {new Date(
                      log.createdAt,
                    ).toLocaleString('en-IN')}
                  </td>
                  <td>
                    <b>{log.action}</b>
                  </td>
                  <td>
                    {log.entityType} · {log.entityId}
                  </td>
                  <td>{log.actorId || 'System'}</td>
                  <td>{log.requestId || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {!logs.length && (
            <div className="empty-state">
              No audit events found.
            </div>
          )}
        </div>
      </section>
    </>
  );
}