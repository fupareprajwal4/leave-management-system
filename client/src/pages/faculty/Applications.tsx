
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Download,
  Edit3,
  Eye,
  Filter,
  Printer,
  Search,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import StatusPill from '../../components/StatusPill';
import { api } from '../../services/api';

export default function Applications() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('All statuses');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/faculty/leave-applications')
      .then((r) => setRows(r.data.data || []))
      .catch((e) =>
        setError(
          e.response?.data?.error?.message || 'Unable to load applications.',
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const data = rows.filter(
    (r) =>
      (filter === 'All statuses' || r.status === filter) &&
      `${r.reference} ${r.leaveTypeId?.name || ''}`
        .toLowerCase()
        .includes(q.toLowerCase()),
  );

  const date = (v: string) =>
    v
      ? new Date(v).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';

  async function download(id: string) {
    try {
      const r = await api.get(`/leave-applications/${id}/pdf`, {
        responseType: 'blob',
      });

      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leave-application.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'PDF generation is not configured.',
      );
    }
  }

  return (
    <>
      <SectionHeading
        eyebrow="YOUR RECORDS"
        title="My applications"
        description="Review real applications, current status and available document actions."
      />

      {error && <div className="error-banner">{error}</div>}

      <div className="panel table-panel">
        <div className="table-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search reference or leave type"
            />
          </div>

          <div className="filter-control">
            <Filter size={15} />
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option>All statuses</option>
              {[
                'Draft',
                'Pending HOD',
                'Returned by HOD',
                'Pending Admin',
                'Returned by Admin',
                'Approved',
                'Rejected by HOD',
                'Rejected by Admin',
                'Withdrawn',
                'Cancelled',
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Leave period</th>
                <th>Days</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {data.map((r) => (
                <tr key={r._id}>
                  <td>
                    <b className="ref-code">{r.reference}</b>
                    <small className="table-sub">
                      Created {date(r.createdAt)}
                    </small>
                  </td>

                  <td>
                    <b>{r.leaveTypeId?.name || 'Leave'}</b>
                    <small className="table-sub">
                      {date(r.startDate)} – {date(r.endDate)}
                    </small>
                  </td>

                  <td>{r.requestedDays}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>

                  <td>
                    <div className="table-actions">
                      <button
                        className="icon-button small"
                        title="Print application"
                        onClick={() => window.print()}
                      >
                        <Printer size={16} />
                      </button>

                      <button
                        className="icon-button small"
                        title="Download official application PDF"
                        onClick={() => void download(r._id)}
                      >
                        <Download size={16} />
                      </button>

                      <button
                        className="icon-button small"
                        title="View application details"
                        onClick={() =>
                          alert(`${r.reference}\n${r.reason || ''}`)
                        }
                      >
                        <Eye size={16} />
                      </button>

                      {[
                        'Draft',
                        'Returned by HOD',
                        'Returned by Admin',
                      ].includes(r.status) && (
                        <button
                          className="icon-button small"
                          title="Edit draft or returned application"
                          onClick={() =>
                            navigate(`/faculty/new?draftId=${r._id}`)
                          }
                        >
                          <Edit3 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {loading && (
            <div className="empty-state">Loading your applications…</div>
          )}

          {!loading && data.length === 0 && (
            <div className="empty-state">
              No applications match these filters.
            </div>
          )}
        </div>

        <div className="table-foot">
          <span>
            Showing {data.length} of {rows.length} records
          </span>
          <span>Live account data</span>
        </div>
      </div>
    </>
  );
}
