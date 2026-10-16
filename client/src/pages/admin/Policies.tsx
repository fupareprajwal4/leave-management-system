import { useEffect, useState } from 'react';
import {
  Check,
  GitBranch,
  Save,
  Settings2,
  ShieldAlert,
} from 'lucide-react';
import SectionHeading from '../../components/SectionHeading';
import { api } from '../../services/api';

type LeaveType = {
  _id: string;
  name: string;
  abbreviation: string;
  description?: string;
  annualEntitlement: number;
  workflow: 'hod' | 'both';
  balancePolicy: 'separate' | 'none' | 'shared';
  template: 'letter' | 'application' | 'both';
  active: boolean;
};

const editableFields = [
  'annualEntitlement',
  'workflow',
  'balancePolicy',
  'template',
  'active',
] as const;

export default function AdminPolicies() {
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [original, setOriginal] = useState<LeaveType[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');

    try {
      const response = await api.get('/admin/leave-types');
      const data = (response.data.data || []) as LeaveType[];

      setTypes(data.map((type) => ({ ...type })));
      setOriginal(data.map((type) => ({ ...type })));
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'Unable to load leave policies.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function update(
    id: string,
    key: keyof LeaveType,
    value: any,
  ) {
    setTypes((previous) =>
      previous.map((type) =>
        type._id === id
          ? { ...type, [key]: value }
          : type,
      ),
    );

    setSaved(false);
  }

  function changedFields(
    type: LeaveType,
    before: LeaveType,
  ) {
    const payload: Record<string, unknown> = {};

    for (const key of editableFields) {
      if (type[key] !== before[key]) {
        payload[key] = type[key];
      }
    }

    if (type.name !== before.name) {
      payload.name = type.name;
    }

    if (type.description !== before.description) {
      payload.description = type.description;
    }

    return payload;
  }

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);

    try {
      const baseline = new Map(
        original.map((type) => [type._id, type]),
      );

      const updates = types
        .map((type) => ({
          type,
          payload: changedFields(
            type,
            baseline.get(type._id)!,
          ),
        }))
        .filter(
          (entry) =>
            Object.keys(entry.payload).length > 0,
        );

      for (const entry of updates) {
        await api.patch(
          `/admin/leave-types/${entry.type._id}`,
          entry.payload,
        );
      }

      await load();
      setSaved(true);
    } catch (e: any) {
      setError(
        e.response?.data?.error?.message ||
          'A policy update failed. Reload the page to confirm which changes were saved before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeading
        eyebrow="POLICY CONFIGURATION"
        title="Leave policies & workflows"
        description="Configure institutional quotas once. Eligible faculty receive their own balances automatically; no per-faculty entitlement approval or data entry is required."
        action={
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={busy}
          >
            <Save size={16} />
            {busy ? 'Saving…' : 'Save policy changes'}
          </button>
        }
      />

      <div className="admin-alert">
        <div className="alert-icon warning">
          <ShieldAlert size={20} />
        </div>

        <div>
          <b>Institutional rules</b>
          <p>
            Confirm official quotas and category eligibility with
            the Establishment Section. Working-day/holiday
            calculations, half-days and carry-forward are not
            enabled by this configuration.
          </p>
        </div>
      </div>

      <div className="policy-callout">
        <b>Accounting period: Calendar year</b>
        <p>1 January – 31 December · Timezone: Asia/Kolkata</p>
        <small>
          Unused leave is not carried forward by the current
          default policy. The current implementation counts
          inclusive calendar days; institutional holidays and
          half-day rules are not configured here.
        </small>
      </div>

      {error && (
        <div className="error-banner">{error}</div>
      )}

      {saved && (
        <div className="success-banner">
          <Check size={16} />
          Policy changes saved and audited. Annual quota changes
          are applied to every current-year faculty and HOD
          balance immediately; days already consumed or reserved
          are preserved. New applications use the updated
          approval route. Existing submitted applications keep
          their recorded workflow.
        </div>
      )}

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h3>
              <Settings2 size={18} />
              Institutional leave categories
            </h3>
            <p>
              Each category's annual entitlement is the rule used
              to initialize separate faculty balances.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Leave category</th>
                <th>Annual quota (days)</th>
                <th>Approval route</th>
                <th>Balance accounting</th>
                <th>Document</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {types.map((type) => (
                <tr key={type._id}>
                  <td>
                    <b>{type.name}</b>
                    <small className="table-sub">
                      {type.abbreviation}
                    </small>
                  </td>

                  <td>
                    <input
                      aria-label={`Annual quota for ${type.name}`}
                      type="number"
                      min="0"
                      max="366"
                      step="1"
                      value={type.annualEntitlement}
                      onChange={(event) =>
                        update(
                          type._id,
                          'annualEntitlement',
                          Number(event.target.value),
                        )
                      }
                    />
                  </td>

                  <td>
                    <select
                      value={type.workflow}
                      onChange={(event) =>
                        update(
                          type._id,
                          'workflow',
                          event.target.value as LeaveType['workflow'],
                        )
                      }
                    >
                      <option value="hod">HOD final</option>
                      <option value="both">
                        HOD + Establishment
                      </option>
                    </select>
                  </td>

                  <td>
                    <select
                      value={type.balancePolicy || 'separate'}
                      onChange={(event) =>
                        update(
                          type._id,
                          'balancePolicy',
                          event.target.value as LeaveType['balancePolicy'],
                        )
                      }
                    >
                      <option value="separate">
                        Individual balance
                      </option>
                      <option value="none">
                        No balance deduction
                      </option>
                      <option value="shared" disabled>
                        Legacy shared (unsupported)
                      </option>
                    </select>
                  </td>

                  <td>
                    <select
                      value={type.template}
                      onChange={(event) =>
                        update(
                          type._id,
                          'template',
                          event.target.value as LeaveType['template'],
                        )
                      }
                    >
                      <option value="letter">Letter</option>
                      <option value="application">
                        Application
                      </option>
                      <option value="both">Both</option>
                    </select>
                  </td>

                  <td>
                    <select
                      value={
                        type.active ? 'active' : 'inactive'
                      }
                      onChange={(event) =>
                        update(
                          type._id,
                          'active',
                          event.target.value === 'active',
                        )
                      }
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {types.length === 0 && (
            <div className="empty-state">
              No leave categories found.
            </div>
          )}
        </div>
      </section>

      <section className="panel workflow-editor">
        <div className="panel-heading">
          <div>
            <h3>
              <GitBranch size={18} />
              How automatic balances work
            </h3>
            <p>
              Configure every category's quota, activation and
              routing here. Current-year balances update
              automatically for eligible faculty and HODs;
              individual corrections remain available in Faculty
              Leave Balances.
            </p>
          </div>
        </div>

        <div className="workflow-options">
          <div className="workflow-option">
            <span className="workflow-num">1</span>
            <div>
              <b>Configure the rule</b>
              <small>
                Set annual quota and which leave categories use a
                balance.
              </small>
            </div>
          </div>

          <div className="workflow-option">
            <span className="workflow-num alt">2</span>
            <div>
              <b>Automatic provisioning</b>
              <small>
                New faculty receive the current policy at first
                sign-in; annual initialization provisions all
                active faculty and HODs.
              </small>
            </div>
          </div>

          <div className="workflow-option">
            <span className="workflow-num">3</span>
            <div>
              <b>Independent accounting</b>
              <small>
                Reservations, consumption and adjustments are
                tracked per faculty member and leave category.
              </small>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}