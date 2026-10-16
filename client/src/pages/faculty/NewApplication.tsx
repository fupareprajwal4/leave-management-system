
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarDays,
  FileText,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import { api } from '../../services/api';

type FormState = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
  absenceAddress: string;
  contactNumber: string;
  headquartersPermission: 'yes' | 'no' | 'not-applicable';
  substituteDetails: string;
};

const emptyForm: FormState = {
  leaveTypeId: '',
  startDate: '',
  endDate: '',
  reason: '',
  absenceAddress: '',
  contactNumber: '',
  headquartersPermission: 'no',
  substituteDetails: '',
};

export default function NewApplication() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const [types, setTypes] = useState<any[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await api.get('/leave-types');
        const items = response.data.data || [];

        if (!active) return;
        setTypes(items);

        const requestedDraftId = searchParams.get('draftId');

        if (requestedDraftId) {
          const draftResponse = await api.get(
            `/faculty/leave-applications/${requestedDraftId}`,
          );
          const draft = draftResponse.data.data;

          if (!active) return;

          if (
            !['Draft', 'Returned by HOD', 'Returned by Admin'].includes(
              draft.status,
            )
          ) {
            throw new Error(
              'Only drafts and returned applications can be edited.',
            );
          }

          setDraftId(draft._id);
          setForm({
            leaveTypeId: String(
              draft.leaveTypeId?._id || draft.leaveTypeId,
            ),
            startDate: String(draft.startDate || '').slice(0, 10),
            endDate: String(draft.endDate || '').slice(0, 10),
            reason: draft.reason || '',
            absenceAddress: draft.absenceAddress || '',
            contactNumber: draft.contactNumber || '',
            headquartersPermission: draft.headquartersPermission || 'no',
            substituteDetails: draft.substituteDetails || '',
          });
        } else if (items[0]) {
          setForm((current) => ({
            ...current,
            leaveTypeId:
              items.find((item: any) => item.abbreviation === 'CL')?._id ||
              items[0]._id,
          }));
        }
      } catch (e: any) {
        if (active) {
          setError(
            e.response?.data?.error?.message ||
              e.message ||
              'Unable to load leave categories or draft.',
          );
        }
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [searchParams]);

  const update = (
    event: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  };

  const days =
    form.startDate && form.endDate
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(`${form.endDate}T00:00:00Z`) -
              Date.parse(`${form.startDate}T00:00:00Z`)) /
              86400000,
          ) + 1,
        )
      : 0;

  const selected = types.find((type) => type._id === form.leaveTypeId);

  async function save(submit: boolean) {
    if (!formRef.current?.reportValidity()) return;

    setBusy(true);
    setError('');
    setMessage('');

    try {
      if (!form.leaveTypeId) {
        throw new Error('No active leave category is configured.');
      }

      let app: any;

      if (draftId) {
        const response = await api.patch(
          `/faculty/leave-applications/${draftId}`,
          form,
        );
        app = response.data.data;
      } else {
        const response = await api.post(
          '/faculty/leave-applications',
          form,
          {
            headers: { 'Idempotency-Key': idempotencyKey },
          },
        );

        app = response.data.data;

        // Keep the created draft ID so a failed submission retry updates
        // this application rather than creating a duplicate.
        setDraftId(app._id);
        window.history.replaceState(
          window.history.state,
          '',
          `/faculty/new?draftId=${app._id}`,
        );
      }

      if (submit) {
        await api.post(`/faculty/leave-applications/${app._id}/submit`);
        setMessage('Application submitted successfully.');
        navigate('/faculty/applications');
      } else {
        setMessage(`Draft saved: ${app.reference}`);
        navigate('/faculty/applications');
      }
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          e.message ||
          'Unable to save application.',
      );
    } finally {
      setBusy(false);
    }
  }

  function clearEditor() {
    if (
      draftId &&
      !window.confirm(
        'The saved draft will remain in My applications. Clear this editor and start a new draft?',
      )
    ) {
      return;
    }

    setDraftId(null);
    navigate('/faculty/new', { replace: true });
    setIdempotencyKey(crypto.randomUUID());
    setForm({
      ...emptyForm,
      leaveTypeId: selected?._id || types[0]?._id || '',
    });
    setError('');
    setMessage('');
  }

  return (
    <>
      <SectionHeading
        eyebrow="LEAVE SERVICES"
        title={draftId ? 'Edit leave application' : 'New leave application'}
        description="Complete the details below. Save a draft or submit it to the appropriate reviewer."
        action={
          <button
            className="btn btn-quiet"
            onClick={() => navigate('/faculty')}
          >
            <ArrowLeft size={16} /> Back to overview
          </button>
        }
      />

      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      <div className="form-layout">
        <form
          ref={formRef}
          className="panel application-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <div className="form-section-title">
            <span className="section-icon">
              <FileText size={18} />
            </span>
            <div>
              <h3>Leave details</h3>
              <p>Enter the dates and reason for your request.</p>
            </div>
            <span className="required-note">* Required</span>
          </div>

          <div className="form-grid">
            <label>
              Leave category <span>*</span>
              <select
                name="leaveTypeId"
                value={form.leaveTypeId}
                onChange={update}
                required
              >
                {types.map((type) => (
                  <option key={type._id} value={type._id}>
                    {type.name} ({type.abbreviation})
                  </option>
                ))}
              </select>
            </label>

            <label>
              Application date
              <input
                value={new Date().toLocaleDateString('en-IN')}
                readOnly
              />
            </label>

            <label>
              From date <span>*</span>
              <input
                type="date"
                name="startDate"
                value={form.startDate}
                onChange={update}
                required
              />
            </label>

            <label>
              To date <span>*</span>
              <input
                type="date"
                name="endDate"
                min={form.startDate || undefined}
                value={form.endDate}
                onChange={update}
                required
              />
            </label>

            <div className="day-count">
              <CalendarDays size={18} />
              <div>
                <b>
                  {days} {days === 1 ? 'day' : 'days'} requested
                </b>
                <small>
                  Calendar-day estimate; institutional working-day rules must
                  be confirmed.
                </small>
              </div>
            </div>

            <label className="full-field">
              Reason for leave <span>*</span>
              <textarea
                name="reason"
                rows={4}
                placeholder="Briefly explain the reason for your leave..."
                value={form.reason}
                onChange={update}
                required
                minLength={5}
              />
            </label>
          </div>

          <div className="form-divider" />

          <div className="form-section-title">
            <span className="section-icon lavender">
              <ShieldCheck size={18} />
            </span>
            <div>
              <h3>Contact & arrangements</h3>
              <p>Details for coordination during your absence.</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="full-field">
              Address during absence
              <input
                name="absenceAddress"
                value={form.absenceAddress}
                onChange={update}
                placeholder="Address where you can be reached"
              />
            </label>

            <label>
              Contact number
              <input
                name="contactNumber"
                type="tel"
                pattern="[0-9+() -]{7,20}"
                value={form.contactNumber}
                onChange={update}
                placeholder="Phone number"
              />
            </label>

            <label>
              Permission to leave headquarters
              <select
                name="headquartersPermission"
                value={form.headquartersPermission}
                onChange={update}
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
                <option value="not-applicable">Not applicable</option>
              </select>
            </label>

            <label className="full-field">
              Substitute / additional charge
              <textarea
                name="substituteDetails"
                rows={2}
                value={form.substituteDetails}
                onChange={update}
                placeholder="Optional — colleague and handover details"
              />
            </label>
          </div>

          <div className="form-divider" />

          <div className="form-section-title">
            <span className="section-icon amber-bg">
              <FileText size={18} />
            </span>
            <div>
              <h3>Supporting documents</h3>
              <p>
                Optional attachments are disabled until private storage is
                configured.
              </p>
            </div>
          </div>

          <div className="info-note">
            Do not upload sensitive documents through this form yet. The
            production storage provider must be configured first.
          </div>

          {selected?.balancePolicy === 'separate' && (
            <div className="info-note">
              Submission requires an individual entitlement for this category
              and year. If none is assigned, the draft will be retained and the
              Establishment Section must assign your balance.
            </div>
          )}

          {selected?.balancePolicy === 'none' && (
            <div className="info-note">
              This category is configured not to deduct from a leave balance.
              Approval routing still applies.
            </div>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={clearEditor}
            >
              Clear form
            </button>

            <button
              className="btn btn-secondary"
              type="submit"
              disabled={busy}
            >
              <Save size={16} /> {busy ? 'Saving…' : 'Save draft'}
            </button>

            <button
              className="btn btn-primary"
              type="button"
              disabled={
                busy ||
                !form.startDate ||
                !form.endDate ||
                form.reason.trim().length < 5
              }
              onClick={() => void save(true)}
            >
              <Send size={16} />{' '}
              {busy
                ? 'Processing…'
                : draftId
                  ? 'Update & submit draft'
                  : 'Submit application'}
            </button>
          </div>

          <p className="form-disclaimer">
            Submission reserves available days for balance-based leave
            categories. Final approval deducts the days; rejection, return or
            withdrawal releases the reservation.
          </p>
        </form>

        <aside className="form-aside">
          <div className="panel summary-panel">
            <span className="aside-label">APPLICATION SUMMARY</span>
            <h3>Review before submission</h3>

            <div className="summary-row">
              <span>Leave type</span>
              <b>{selected?.name || 'Select category'}</b>
            </div>
            <div className="summary-row">
              <span>From</span>
              <b>{form.startDate || 'Not selected'}</b>
            </div>
            <div className="summary-row">
              <span>To</span>
              <b>{form.endDate || 'Not selected'}</b>
            </div>
            <div className="summary-total">
              <span>Estimated duration</span>
              <b>{days} days</b>
            </div>

            <div className="summary-route">
              <span className="route-dot" />
              <div>
                <b>Head of Department</b>
                <small>First review stage, except a HOD's own request</small>
              </div>
            </div>

            <div className="summary-route">
              <span className="route-dot muted" />
              <div>
                <b>Establishment Section</b>
                <small>
                  {selected?.workflow === 'hod'
                    ? 'Not normally required for this category'
                    : 'Required by current category configuration'}
                </small>
              </div>
            </div>
          </div>

          <div className="help-card">
            <div className="help-icon">
              <ShieldCheck size={20} />
            </div>
            <h4>Institutional access control</h4>
            <p>
              Application access is enforced by the server using your
              provisioned account and department assignment.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
