'use strict';

const crypto = require('node:crypto');

const ENRICHABLE = new Set(['pocName', 'jobTitle', 'arizonaCity', 'companyEmail', 'companyPhone']);
const URL_PATTERN = /^https?:\/\/(?!.*@)[^\s/?#]+(?:[/?#][^\s]*)?$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function buildEnrichmentReview({ existingCompanies, proposedEvidence, approvedSourceBaseUrl = '', now = new Date().toISOString() } = {}) {
  if (!Array.isArray(existingCompanies) || !Array.isArray(proposedEvidence)) throw new Error('Existing company list and evidence proposals are required.');
  const allowed = new Set(existingCompanies.map(row => String(row.id)));
  const seen = new Set();
  const accepted = [], review = [], rejected = [];
  for (const item of proposedEvidence) {
    const companyId = String(item.companyId || '');
    if (!allowed.has(companyId)) { rejected.push({ reason: 'COMPANY_NOT_IN_EXISTING_SET' }); continue; }
    if (!ENRICHABLE.has(item.field) || !String(item.value || '').trim()) { rejected.push({ companyId, reason: 'FIELD_OR_VALUE_INVALID' }); continue; }
    if (!URL_PATTERN.test(String(item.sourceUrl || ''))) { review.push({ companyId, field: item.field, reason: 'SOURCE_URL_MISSING_OR_INVALID' }); continue; }
    let parsedUrl, approvedUrl;
    try { parsedUrl = new URL(item.sourceUrl); approvedUrl = new URL(approvedSourceBaseUrl); } catch (_) {}
    if (!parsedUrl || !approvedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password ||
        !(parsedUrl.hostname === approvedUrl.hostname || parsedUrl.hostname.endsWith(`.${approvedUrl.hostname}`))) {
      review.push({ companyId, field: item.field, reason: 'SOURCE_HOST_NOT_IN_APPROVED_REGISTRY' }); continue;
    }
    const key = `${companyId}\0${item.field}`;
    if (seen.has(key)) { review.push({ companyId, field: item.field, reason: 'CONFLICTING_PROPOSALS' }); continue; }
    seen.add(key);
    const value = String(item.value).trim();
    const confident = item.confidence === 'HIGH' && item.ambiguous !== true && item.sourceKind && item.observedAt && Number.isFinite(Date.parse(item.observedAt));
    const proposal = { companyId, field: item.field, value, sourceUrl: item.sourceUrl, sourceKind: String(item.sourceKind || 'UNSPECIFIED'),
      observedAt: item.observedAt || now, confidence: item.confidence || 'UNKNOWN', evidenceHash: hash(`${companyId}\0${item.field}\0${value}\0${item.sourceUrl}`) };
    (confident ? accepted : review).push(confident ? proposal : { ...proposal, reason: 'AMBIGUOUS_OR_INSUFFICIENT_EVIDENCE' });
  }
  return Object.freeze({ accepted, review, rejected, existingOnly: true, writesCompanyFields: false,
    counts: Object.freeze({ accepted: accepted.length, review: review.length, rejected: rejected.length }) });
}

// Stores auditable source evidence only; field changes remain a reviewed/manual operation.
async function persistEnrichmentEvidence(client, plan, { sourceId, dryRun = true } = {}) {
  if (!plan || plan.existingOnly !== true || plan.writesCompanyFields !== false) throw new Error('Invalid existing-record enrichment plan.');
  if (dryRun) return { evidenceInserted: 0, dryRun: true, reviewCount: plan.review.length + plan.accepted.length };
  if (!sourceId) throw new Error('A registered permitted source ID is required.');
  await client.query('BEGIN');
  try {
    let evidenceInserted = 0;
    for (const item of plan.accepted) {
      const key = `enrichment:${item.evidenceHash}`;
      const evidenceText = `${item.field} proposed value: ${item.value}; evidence key ${key}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      let sourceEvidenceId = (await client.query(`SELECT id FROM lead_intel.source_evidence
        WHERE company_id=$1 AND source_id=$2 AND source_url=$3 AND evidence_text=$4 LIMIT 1`,
      [item.companyId, sourceId, item.sourceUrl, evidenceText])).rows[0]?.id;
      if (!sourceEvidenceId) {
        const result = await client.query(`INSERT INTO lead_intel.source_evidence
          (company_id,source_id,evidence_type,source_url,evidence_text,access_policy_snapshot,confidence)
          VALUES($1,$2,$3,$4,$5,$6,0.900) RETURNING id`, [item.companyId, sourceId,
          item.field === 'arizonaCity' ? 'LOCATION' : ['companyEmail','companyPhone'].includes(item.field) ? 'CONTACT_POINT' : 'CONTACT_IDENTITY',
          item.sourceUrl, evidenceText, `PERMITTED_SOURCE_REVIEW:${item.sourceKind}`]);
        sourceEvidenceId = result.rows[0]?.id;
        evidenceInserted += result.rowCount;
      }
      if (!sourceEvidenceId) throw new Error('ENRICHMENT_EVIDENCE_IDEMPOTENCY_LOOKUP_FAILED');
      await client.query(`INSERT INTO lead_intel.field_evidence(company_id,field_key,source_evidence_id,observed_value_sha256,idempotency_key,observed_at,confidence)
        VALUES($1,$2,$3,$4,$5,$6,0.900) ON CONFLICT(idempotency_key) DO NOTHING`,
      [item.companyId, item.field, sourceEvidenceId, item.evidenceHash, key, item.observedAt]);
    }
    for (const item of plan.review) {
      const idempotencyKey = `enrichment-review:${hash(`${item.companyId}\0${item.field}\0${item.reason}`)}`;
      await client.query(`INSERT INTO lead_intel.jobs(job_type,idempotency_key,payload)
        VALUES('MANUAL_REVIEW',$1,$2::jsonb) ON CONFLICT(idempotency_key) DO NOTHING`,
      [idempotencyKey, JSON.stringify({ kind: 'ENRICHMENT_REVIEW', companyId: item.companyId, field: item.field, reason: item.reason })]);
    }
    await client.query('COMMIT');
    return { evidenceInserted, dryRun: false, reviewCount: plan.review.length + plan.accepted.length };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

module.exports = { ENRICHABLE, buildEnrichmentReview, persistEnrichmentEvidence };
