'use strict';

// This is a backend runtime snapshot of the schema declared by apps-script/Config.gs.
// The compatibility test compares it to Config.gs so drift fails loudly.
const PROSPECTS_HEADERS = Object.freeze([
  'Company Name', 'Designation', 'POC Contact Number', 'Company Contact Number',
  'POC Email ID', 'Department', 'Employee Size', 'LI POC Profile', 'POC Name',
  'Company Website', 'Company Domain', 'Arizona City', 'Arizona Address',
  'Industry', 'ICP Score', 'Brand Ownership Evidence', 'Packaging Opportunity',
  'Source URL', 'Contact Source URL', 'Email Verification Status',
  'Phone Verification Status', 'Research Status', 'Last Checked', 'Date Added',
  'Lead ID', 'Notes',
  'Company Email', 'Company Email Source URL', 'POC Email Source URL',
  'Email Syntax Status', 'Email Domain MX Status', 'Email Deliverability Status',
  'Email Last Verified', 'Company Phone Source URL', 'POC Phone Source URL',
  'Phone Format Status', 'Phone Activity Status', 'Phone Last Verified',
  'LinkedIn Source URL', 'Employee Size Source URL', 'Contact Completeness Score',
  'Verification Notes'
]);

const FIELD_TO_HEADER = Object.freeze({
  companyName: 'Company Name',
  designation: 'Designation',
  pocContactNumber: 'POC Contact Number',
  companyContactNumber: 'Company Contact Number',
  pocEmailId: 'POC Email ID',
  department: 'Department',
  employeeSize: 'Employee Size',
  liPocProfile: 'LI POC Profile',
  pocName: 'POC Name',
  companyWebsite: 'Company Website',
  companyDomain: 'Company Domain',
  arizonaCity: 'Arizona City',
  arizonaAddress: 'Arizona Address',
  industry: 'Industry',
  icpScore: 'ICP Score',
  brandOwnershipEvidence: 'Brand Ownership Evidence',
  packagingOpportunity: 'Packaging Opportunity',
  sourceUrl: 'Source URL',
  contactSourceUrl: 'Contact Source URL',
  emailVerificationStatus: 'Email Verification Status',
  phoneVerificationStatus: 'Phone Verification Status',
  researchStatus: 'Research Status',
  lastChecked: 'Last Checked',
  dateAdded: 'Date Added',
  leadId: 'Lead ID',
  notes: 'Notes',
  companyEmail: 'Company Email',
  companyEmailSourceUrl: 'Company Email Source URL',
  pocEmailSourceUrl: 'POC Email Source URL',
  emailSyntaxStatus: 'Email Syntax Status',
  emailDomainMxStatus: 'Email Domain MX Status',
  emailDeliverabilityStatus: 'Email Deliverability Status',
  emailLastVerified: 'Email Last Verified',
  companyPhoneSourceUrl: 'Company Phone Source URL',
  pocPhoneSourceUrl: 'POC Phone Source URL',
  phoneFormatStatus: 'Phone Format Status',
  phoneActivityStatus: 'Phone Activity Status',
  phoneLastVerified: 'Phone Last Verified',
  linkedInSourceUrl: 'LinkedIn Source URL',
  employeeSizeSourceUrl: 'Employee Size Source URL',
  contactCompletenessScore: 'Contact Completeness Score',
  verificationNotes: 'Verification Notes'
});

const HEADER_INDEX = new Map(PROSPECTS_HEADERS.map((header, index) => [header, index]));
const ALLOWED_FIELDS = new Set(Object.keys(FIELD_TO_HEADER));

/**
 * Convert a normalized backend lead to one row matching the exact 42-cell
 * Prospects contract. Omitted/null values become empty cells; no values are
 * inferred. Contact channels remain separate because each has its own field.
 * @param {Record<string, unknown>} record
 * @returns {Array<string|number|boolean|Date>}
 */
function toProspectsRow(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Lead record must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Lead record must be a plain object.');
  }

  const unknownFields = Object.keys(record).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length) {
    throw new Error(`Unknown lead field(s): ${unknownFields.join(', ')}`);
  }
  if (typeof record.companyName !== 'string' || !record.companyName.trim()) {
    throw new Error('companyName is required and must be a non-empty string.');
  }
  if (typeof record.leadId !== 'string' || !record.leadId.trim()) {
    throw new Error('leadId is required and must be a non-empty string.');
  }

  const row = Array(PROSPECTS_HEADERS.length).fill('');
  for (const [field, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date.`);
      row[HEADER_INDEX.get(FIELD_TO_HEADER[field])] = new Date(value.getTime());
      continue;
    }
    const valueType = typeof value;
    if (!['string', 'number', 'boolean'].includes(valueType)) {
      throw new TypeError(`${field} must be a string, number, boolean, Date, or blank.`);
    }
    if (valueType === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`${field} must be a finite number.`);
    }
    row[HEADER_INDEX.get(FIELD_TO_HEADER[field])] = value;
  }
  return row;
}

module.exports = { PROSPECTS_HEADERS, FIELD_TO_HEADER, toProspectsRow };
