export const DEPARTMENTS = [
  { name: 'Computer Science and Engineering', code: 'CSE' },
  { name: 'Information Technology', code: 'IT' },
  { name: 'Chemical Engineering', code: 'CHE' },
  { name: 'Electrical Engineering', code: 'EE' },
  { name: 'Electronics Engineering', code: 'ECE' },
  { name: 'Production Engineering', code: 'PE' },
  { name: 'Civil Engineering', code: 'CE' },
  { name: 'Instrumentation Engineering', code: 'IE' },
  { name: 'Mechanical Engineering', code: 'ME' },
  { name: 'Textile Technology', code: 'TT' },
] as const;

// Baseline values for a new installation. Other leave-category quotas remain 0
// until Establishment confirms the applicable institutional rule.
export const INITIAL_LEAVE_TYPES = [
  {
    name: 'Casual Leave',
    abbreviation: 'CL',
    annualEntitlement: 10,
    workflow: 'hod',
  },
  {
    name: 'Earned Leave',
    abbreviation: 'EL',
    annualEntitlement: 8,
    workflow: 'both',
  },
  {
    name: 'CEL (expansion to confirm)',
    abbreviation: 'CEL',
    annualEntitlement: 0,
    workflow: 'both',
  },
  {
    name: 'Commuted Leave',
    abbreviation: 'COM',
    annualEntitlement: 0,
    workflow: 'both',
  },
  {
    name: 'Half Pay Leave',
    abbreviation: 'HPL',
    annualEntitlement: 0,
    workflow: 'both',
  },
  {
    name: 'Medical-related leave',
    abbreviation: 'MED',
    annualEntitlement: 0,
    workflow: 'both',
  },
] as const;