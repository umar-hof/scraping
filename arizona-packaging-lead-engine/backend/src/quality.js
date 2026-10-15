'use strict';

const crypto = require('node:crypto');

const ICP_INDUSTRY_WEIGHTS = Object.freeze({
  'cosmetics & skincare brands': 92,
  'candles & home fragrance': 88,
  'specialty coffee, tea & food': 86,
  'supplements & wellness': 84,
  'soap, bath & body': 80,
  'e-commerce / dtc lifestyle': 78,
  'subscription box companies': 72,
  'gifting, events & corporate gifts': 66
});
const PHYSICAL_PRODUCT = /\b(product|products|brand|skincare|soap|candle|coffee|tea|food|sauce|snack|wellness|cosmetic|body care|retail|packaging|bottle|jar|box|pouch)\b/i;
const ARIZONA_LOCATION = /(?:\barizona\b|,\s*az\b|\baz\s+\d{5}\b)/i;
const SOURCE_FIELDS = Object.freeze({
  companyName: 'sourceUrl', designation: 'contactSourceUrl', department: 'contactSourceUrl',
  pocName: 'contactSourceUrl', companyWebsite: 'sourceUrl', companyDomain: 'sourceUrl',
  arizonaCity: 'sourceUrl', arizonaAddress: 'sourceUrl', industry: 'sourceUrl', icpScore: 'sourceUrl',
  brandOwnershipEvidence: 'sourceUrl', packagingOpportunity: 'sourceUrl', liPocProfile: 'linkedInSourceUrl',
  companyEmail: 'companyEmailSourceUrl', pocEmailId: 'pocEmailSourceUrl',
  companyContactNumber: 'companyPhoneSourceUrl', pocContactNumber: 'pocPhoneSourceUrl',
  liPocProfile: 'linkedInSourceUrl', employeeSize: 'employeeSizeSourceUrl'
});

function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normalizeDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return '';
    return host;
  } catch (_) { return ''; }
}

function normalizeUsPhone(value) {
  const text = String(value || '').trim();
  if (!text) return { e164: '', formatStatus: 'MISSING' };
  const digits = text.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const valid = national.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(national);
  return valid ? { e164: `+1${national}`, formatStatus: 'VALID_FORMAT' } : { e164: '', formatStatus: 'INVALID_FORMAT' };
}

function isEvidenceUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol); }
  catch (_) { return false; }
}

function inspectExistingProspect(record) {
  const issues = [];
  const industryKey = String(record.industry || '').trim().toLowerCase();
  const industryScore = ICP_INDUSTRY_WEIGHTS[industryKey] || 0;
  const statedScore = Number(record.icpScore);
  const arizonaConfirmed = ARIZONA_LOCATION.test(`${record.arizonaAddress || ''} ${record.arizonaCity || ''}`) && isEvidenceUrl(record.sourceUrl);
  if (!record.leadId) issues.push('LEAD_ID_MISSING');
  if (!record.companyName) issues.push('COMPANY_NAME_MISSING');
  if (!arizonaConfirmed) issues.push('ARIZONA_LOCATION_NEEDS_REVIEW');
  if (!String(record.arizonaCity || '').trim()) issues.push('ARIZONA_CITY_UNKNOWN');
  if (!isEvidenceUrl(record.sourceUrl)) issues.push('COMPANY_SOURCE_MISSING_OR_INVALID');
  if (!industryScore) issues.push('INDUSTRY_NEEDS_REVIEW');
  if (!PHYSICAL_PRODUCT.test(`${record.brandOwnershipEvidence || ''} ${record.packagingOpportunity || ''}`)) issues.push('PHYSICAL_PRODUCT_EVIDENCE_NEEDS_REVIEW');
  if (!Number.isFinite(statedScore) || statedScore < 60) issues.push('ICP_SCORE_BELOW_THRESHOLD_OR_MISSING');
  for (const field of ['companyEmail', 'pocEmailId', 'companyContactNumber', 'pocContactNumber']) {
    if (record[field] && !isEvidenceUrl(record[SOURCE_FIELDS[field]])) issues.push(`${field.toUpperCase()}_SOURCE_MISSING`);
  }
  const websiteDomain = normalizeDomain(record.companyWebsite);
  const storedDomain = normalizeDomain(record.companyDomain);
  if (websiteDomain && storedDomain && websiteDomain !== storedDomain) issues.push('COMPANY_DOMAIN_CONFLICT');
  if (/^(?:info|sales|support|contact|hello|admin|orders|office)\s*[@+]/i.test(String(record.pocEmailId || ''))) {
    issues.push('GENERIC_COMPANY_MAILBOX_IN_POC_FIELD');
  }
  if (record.pocContactNumber && record.companyContactNumber) {
    const personNumber = normalizeUsPhone(record.pocContactNumber).e164;
    const companyNumber = normalizeUsPhone(record.companyContactNumber).e164;
    if (personNumber && companyNumber && personNumber === companyNumber) issues.push('POC_PHONE_MATCHES_COMPANY_PHONE');
  }
  if ((record.companyEmail || record.pocEmailId) && ['UNVERIFIED', 'UNKNOWN', 'MISSING'].includes(String(record.emailDeliverabilityStatus || 'UNVERIFIED').toUpperCase())) {
    issues.push('EMAIL_DELIVERABILITY_UNVERIFIED');
  }
  if ((record.companyContactNumber || record.pocContactNumber) && ['UNVERIFIED', 'UNKNOWN', 'MISSING'].includes(String(record.phoneActivityStatus || 'UNVERIFIED').toUpperCase())) {
    issues.push('PHONE_ACTIVITY_UNVERIFIED');
  }
  const qualified = Boolean(record.leadId && record.companyName && arizonaConfirmed && industryScore >= 60 &&
    PHYSICAL_PRODUCT.test(`${record.brandOwnershipEvidence || ''} ${record.packagingOpportunity || ''}`) &&
    Number.isFinite(statedScore) && statedScore >= 60 && isEvidenceUrl(record.sourceUrl));
  return Object.freeze({
    leadId: String(record.leadId || ''), normalizedCompanyName: normalizeName(record.companyName),
    domain: normalizeDomain(record.companyWebsite || record.companyDomain),
    arizonaStatus: arizonaConfirmed ? 'SUPPORTED' : 'REVIEW',
    icpStatus: qualified ? 'QUALIFIED' : 'NEEDS_REVIEW',
    calculatedIndustryWeight: industryScore,
    qualificationStatus: qualified ? 'ELIGIBLE_EXISTING_ONLY' : 'EXCLUDED_PENDING_REVIEW',
    issues
  });
}

function fieldEvidencePlan(record) {
  const fields = [];
  for (const [field, sourceField] of Object.entries(SOURCE_FIELDS)) {
    const value = record[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (/^(UNKNOWN|MISSING|UNVERIFIED|N\/A)$/i.test(String(value).trim())) continue;
    const sourceUrl = String(record[sourceField] || '').split('|')[0].trim();
    fields.push({ fieldKey: field, sourceUrl: isEvidenceUrl(sourceUrl) ? sourceUrl : '',
      status: isEvidenceUrl(sourceUrl) ? 'SOURCE_LINKED' : 'NEEDS_SOURCE',
      observedValueSha256: crypto.createHash('sha256').update(String(value)).digest('hex') });
  }
  return fields;
}

function buildExistingRecordAudit(records) {
  const idCounts = new Map();
  for (const record of records) {
    const leadId = String(record.leadId || '').trim();
    if (leadId) idCounts.set(leadId, (idCounts.get(leadId) || 0) + 1);
  }
  const names = new Map();
  const domains = new Map();
  const audited = records.map((record) => {
    const inspected = inspectExistingProspect(record);
    const duplicates = [];
    if (inspected.leadId && idCounts.get(inspected.leadId) > 1) duplicates.push('DUPLICATE_LEAD_ID');
    if (inspected.normalizedCompanyName) {
      if (names.has(inspected.normalizedCompanyName)) duplicates.push('POSSIBLE_DUPLICATE_COMPANY_NAME');
      names.set(inspected.normalizedCompanyName, true);
    }
    if (inspected.domain) {
      const list = domains.get(inspected.domain) || [];
      list.push(inspected.leadId);
      domains.set(inspected.domain, list);
    }
    return { leadId: inspected.leadId, qualificationStatus: inspected.qualificationStatus,
      arizonaStatus: inspected.arizonaStatus, issues: [...inspected.issues, ...duplicates],
      fieldEvidence: fieldEvidencePlan(record) };
  });
  const sharedDomains = [...domains].filter(([, leadIds]) => leadIds.length > 1).map(([domain, leadIds]) => ({ domain, leadIds }));
  return { total: records.length, audited, sharedDomains, noCompaniesCreated: true };
}

module.exports = { normalizeName, normalizeDomain, normalizeUsPhone, inspectExistingProspect, fieldEvidencePlan, buildExistingRecordAudit };
