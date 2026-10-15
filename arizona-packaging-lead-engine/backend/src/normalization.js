'use strict';

const crypto = require('node:crypto');
const { PROSPECTS_HEADERS } = require('./prospects-contract');
const { inspectExistingProspect, normalizeDomain, normalizeUsPhone, fieldEvidencePlan } = require('./quality');

const SOURCE_KEY_PREFIX = 'google-sheets-snapshot:';
const EMPTY_MARKERS = /^(?:unknown|missing|unverified|n\/a|not available|none)$/i;
const SOURCE_FIELDS = Object.freeze({
  companyName: 'sourceUrl', companyWebsite: 'sourceUrl', companyDomain: 'sourceUrl',
  arizonaCity: 'sourceUrl', arizonaAddress: 'sourceUrl', industry: 'sourceUrl',
  icpScore: 'sourceUrl', brandOwnershipEvidence: 'sourceUrl', packagingOpportunity: 'sourceUrl',
  pocName: 'contactSourceUrl', designation: 'contactSourceUrl', department: 'contactSourceUrl',
  companyEmail: 'companyEmailSourceUrl', pocEmailId: 'pocEmailSourceUrl',
  companyContactNumber: 'companyPhoneSourceUrl', pocContactNumber: 'pocPhoneSourceUrl',
  liPocProfile: 'linkedInSourceUrl', employeeSize: 'employeeSizeSourceUrl'
});

function clean(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return !text || EMPTY_MARKERS.test(text) ? '' : text;
}

function validHttpUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : ''; }
  catch (_) { return ''; }
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function mapCells(cells) {
  if (!Array.isArray(cells) || cells.length !== 42) throw new Error('Snapshot row must contain exactly 42 cells.');
  const out = {};
  PROSPECTS_HEADERS.forEach((header, index) => { out[header] = cells[index]; });
  return out;
}

function parseSnapshotRow(row) {
  const cells = Array.isArray(row.row_payload) ? row.row_payload : JSON.parse(row.row_payload);
  const v = mapCells(cells);
  const leadId = clean(v['Lead ID']);
  if (!leadId || leadId !== String(row.lead_id || leadId)) throw new Error('Snapshot Lead ID does not match its immutable row identity.');
  const record = {
    leadId, companyName: clean(v['Company Name']), designation: clean(v.Designation),
    pocContactNumber: clean(v['POC Contact Number']), companyContactNumber: clean(v['Company Contact Number']),
    pocEmailId: clean(v['POC Email ID']), department: clean(v.Department), employeeSize: clean(v['Employee Size']),
    liPocProfile: clean(v['LI POC Profile']), pocName: clean(v['POC Name']), companyWebsite: clean(v['Company Website']),
    companyDomain: clean(v['Company Domain']), arizonaCity: clean(v['Arizona City']), arizonaAddress: clean(v['Arizona Address']),
    industry: clean(v.Industry), icpScore: clean(v['ICP Score']), brandOwnershipEvidence: clean(v['Brand Ownership Evidence']),
    packagingOpportunity: clean(v['Packaging Opportunity']), sourceUrl: clean(v['Source URL']),
    contactSourceUrl: clean(v['Contact Source URL']), emailVerificationStatus: clean(v['Email Verification Status']),
    phoneVerificationStatus: clean(v['Phone Verification Status']), researchStatus: clean(v['Research Status']),
    lastChecked: clean(v['Last Checked']), dateAdded: clean(v['Date Added']), companyEmail: clean(v['Company Email']),
    companyEmailSourceUrl: clean(v['Company Email Source URL']), pocEmailSourceUrl: clean(v['POC Email Source URL']),
    emailSyntaxStatus: clean(v['Email Syntax Status']), emailDomainMxStatus: clean(v['Email Domain MX Status']),
    emailDeliverabilityStatus: clean(v['Email Deliverability Status']), companyPhoneSourceUrl: clean(v['Company Phone Source URL']),
    pocPhoneSourceUrl: clean(v['POC Phone Source URL']), phoneFormatStatus: clean(v['Phone Format Status']),
    phoneActivityStatus: clean(v['Phone Activity Status']), linkedInSourceUrl: clean(v['LinkedIn Source URL']),
    employeeSizeSourceUrl: clean(v['Employee Size Source URL'])
  };
  if (!record.companyName) throw new Error('Snapshot company name is required.');
  return { snapshotId: row.id, snapshotRowNumber: Number(row.source_row_number), payloadSha256: row.payload_sha256, cells, record };
}

function buildNormalizationPreview(snapshotRows, { spreadsheetId, existingIdentifiers = [], existingCompanies = [] } = {}) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(String(spreadsheetId || ''))) throw new Error('Existing spreadsheet ID is required.');
  if (!Array.isArray(snapshotRows) || snapshotRows.length !== 20) throw new Error('Expected exactly 20 imported source snapshots.');
  const rows = snapshotRows.map(parseSnapshotRow);
  const leadIds = new Set();
  const names = new Set();
  const identifiers = new Map(existingIdentifiers.map(x => [String(x.normalized_value), x]));
  const companyNames = new Map();
  for (const c of existingCompanies) {
    const k = clean(c.normalized_name).toLowerCase();
    if (k) companyNames.set(k, [...(companyNames.get(k) || []), c]);
  }
  const planned = rows.map(({ snapshotId, snapshotRowNumber, payloadSha256, record, cells }) => {
    if (leadIds.has(record.leadId)) throw new Error('Duplicate Lead ID in source snapshots.');
    leadIds.add(record.leadId);
    const nameKey = record.companyName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (names.has(nameKey)) throw new Error('Duplicate company name in source snapshots needs manual identity review.');
    names.add(nameKey);
    const existingId = identifiers.get(record.leadId);
    if (existingId && existingId.identifier_type !== 'APPS_SCRIPT_LEAD_ID') throw new Error('Existing external identifier conflicts with Lead ID namespace.');
    const namedMatches = companyNames.get(nameKey) || [];
    const identityConflict = !existingId && namedMatches.length > 0;
    const quality = inspectExistingProspect(record);
    const issues = new Set(quality.issues);
    if (identityConflict) issues.add('AMBIGUOUS_EXISTING_COMPANY_IDENTITY');
    if (record.pocName && !validHttpUrl(record.contactSourceUrl)) issues.add('POC_IDENTITY_SOURCE_MISSING');
    if (!record.pocName && (record.pocEmailId || record.pocContactNumber || record.liPocProfile)) issues.add('POC_DETAILS_UNLINKED_NO_NAMED_CONTACT');
    for (const f of ['pocName','designation','companyEmail','pocEmailId','companyContactNumber','pocContactNumber','liPocProfile','employeeSize','arizonaCity']) {
      if (!record[f]) issues.add(`MISSING_${f.replace(/[A-Z]/g, m => `_${m}`).toUpperCase()}`);
    }
    const evidence = fieldEvidencePlan(record);
    const sourceGaps = evidence.filter(x => x.status === 'NEEDS_SOURCE');
    if (sourceGaps.length) issues.add('FIELD_SOURCE_EVIDENCE_GAP');
    const domain = normalizeDomain(record.companyWebsite || record.companyDomain);
    const namedPoc = Boolean(record.pocName);
    const companyPointCount = Number(Boolean(record.companyEmail)) + Number(Boolean(record.companyContactNumber));
    const personPointCount = namedPoc ? Number(Boolean(record.pocEmailId)) + Number(Boolean(record.pocContactNumber)) + Number(Boolean(record.liPocProfile)) : 0;
    return {
      snapshotId, snapshotRowNumber, payloadSha256, leadId: record.leadId, companyName: record.companyName,
      identityAction: existingId ? 'REUSE_BY_LEAD_ID' : identityConflict ? 'CONFLICT_REVIEW' : 'CREATE_COMPANY',
      record, cells, domain, location: {
        city: record.arizonaCity || null, address: record.arizonaAddress || null,
        stateCode: /\barizona\b|,\s*az\b|\baz\s+\d{5}\b/i.test(`${record.arizonaCity} ${record.arizonaAddress}`) ? 'AZ' : null,
        postalCode: (record.arizonaAddress.match(/\b\d{5}(?:-\d{4})?\b/) || [])[0] || null
      },
      qualificationStatus: quality.qualificationStatus, arizonaStatus: quality.arizonaStatus,
      contactPlan: namedPoc ? 'CREATE_OR_REUSE_NAMED_POC' : 'NO_NAMED_CONTACT',
      companyPointCount, personPointCount, fieldEvidenceCount: evidence.length - sourceGaps.length,
      sourceGaps, issues: [...issues].sort(), quality
    };
  });
  const duplicateDomains = new Map();
  for (const r of planned) if (r.domain) duplicateDomains.set(r.domain, (duplicateDomains.get(r.domain) || 0) + 1);
  const planBody = planned.map(r => ({ leadId: r.leadId, snapshotId: r.snapshotId, payloadSha256: r.payloadSha256, identityAction: r.identityAction, issues: r.issues }));
  const reviewItems = planned.filter(r => r.issues.length).map(r => ({ leadId: r.leadId, snapshotId: r.snapshotId, issues: r.issues }));
  const uniquePhones = new Set();
  for (const r of planned) {
    if (r.qualificationStatus !== 'ELIGIBLE_EXISTING_ONLY') continue;
    const raw = r.record.pocContactNumber || r.record.companyContactNumber;
    const p = normalizeUsPhone(raw);
    if (p.e164 && validHttpUrl(r.record.pocContactNumber ? r.record.pocPhoneSourceUrl : r.record.companyPhoneSourceUrl)) uniquePhones.add(p.e164);
  }
  const counts = {
    snapshots: planned.length, companiesToCreate: planned.filter(r => r.identityAction === 'CREATE_COMPANY').length,
    companiesToReuse: planned.filter(r => r.identityAction === 'REUSE_BY_LEAD_ID').length,
    identityConflicts: planned.filter(r => r.identityAction === 'CONFLICT_REVIEW').length,
    locationsSupported: planned.filter(r => r.location.stateCode === 'AZ' && (r.location.city || r.location.address)).length,
    namedContactsToCreateOrReuse: planned.filter(r => r.contactPlan === 'CREATE_OR_REUSE_NAMED_POC').length,
    companyContactPoints: planned.reduce((n, r) => n + r.companyPointCount, 0),
    personContactPoints: planned.reduce((n, r) => n + r.personPointCount, 0),
    qualified: planned.filter(r => r.qualificationStatus === 'ELIGIBLE_EXISTING_ONLY').length,
    qualificationExceptions: planned.filter(r => r.qualificationStatus !== 'ELIGIBLE_EXISTING_ONLY').length,
    uniqueSourcedPhoneCandidates: uniquePhones.size,
    sourceEvidenceGaps: planned.reduce((n, r) => n + r.sourceGaps.length, 0),
    reviewItems: reviewItems.length,
    sharedDomains: [...duplicateDomains.values()].filter(n => n > 1).length
  };
  const planSha256 = hash(JSON.stringify({ spreadsheetId, rows: planBody }));
  return Object.freeze({ spreadsheetId, rows: planned, reviewItems, counts, planSha256, noNewCompanies: true,
    contactsOnlyFromNamedEvidence: true, deliverabilityForcedUnverified: true, phoneActivityForcedUnverified: true });
}

function normalizeSuppressionSnapshot({ sourceKey, sourceUrl, capturedAt, completenessStatus, entries } = {}) {
  if (!clean(sourceKey) || !validHttpUrl(sourceUrl)) throw new Error('Suppression snapshot requires a source identifier and source URL.');
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) throw new Error('Suppression snapshot requires a valid capture timestamp.');
  if (!Array.isArray(entries)) throw new Error('Suppression entries must be an array.');
  const complete = completenessStatus === 'COMPLETE';
  const normalized = new Map();
  for (const entry of entries) {
    const phone = normalizeUsPhone(entry.phone);
    if (!phone.e164) throw new Error('Suppression snapshot contains an invalid phone value.');
    const old = normalized.get(phone.e164);
    normalized.set(phone.e164, { phoneE164: phone.e164, leadId: clean(entry.leadId), scope: entry.scope || 'PHONE', duplicateCount: (old?.duplicateCount || 0) + 1 });
  }
  return Object.freeze({ sourceKey: clean(sourceKey), sourceUrl: validHttpUrl(sourceUrl), capturedAt: new Date(capturedAt).toISOString(),
    completenessStatus: complete ? 'COMPLETE' : 'INCOMPLETE', validated: true, inputCount: entries.length,
    duplicateCount: entries.length - normalized.size, entries: [...normalized.values()] });
}

function assertSuppressionImportable(snapshot) {
  if (!snapshot || snapshot.completenessStatus !== 'COMPLETE') throw new Error('Suppression import blocked: a complete authoritative suppression snapshot is required.');
  return true;
}

function matchSuppressionSnapshot(snapshot, phonePoints) {
  assertSuppressionImportable(snapshot);
  const byPhone = new Map();
  for (const point of phonePoints || []) {
    if (point.channel !== 'PHONE' || !point.normalized_value) continue;
    const key = normalizeUsPhone(point.normalized_value).e164;
    if (key) byPhone.set(key, [...(byPhone.get(key) || []), point]);
  }
  const matches = [], unmatched = [];
  for (const entry of snapshot.entries) {
    const found = byPhone.get(entry.phoneE164) || [];
    if (!found.length) unmatched.push(entry.phoneE164);
    for (const point of found) matches.push({ entry, point });
  }
  return { matches, unmatched, complete: true, sourceKey: snapshot.sourceKey, capturedAt: snapshot.capturedAt,
    duplicateCount: snapshot.duplicateCount };
}

async function persistSuppressionSnapshot(client, snapshot, { sourceId, confirmImport = false } = {}) {
  assertSuppressionImportable(snapshot);
  if (confirmImport !== true || !sourceId) throw new Error('Suppression import requires a source registry ID and explicit import confirmation.');
  await client.query('BEGIN');
  try {
    const lookup = await client.query(
      `SELECT id,company_id,contact_id,scope_kind,channel,normalized_value FROM lead_intel.contact_points
       WHERE channel='PHONE' AND normalized_value=ANY($1::text[])`, [snapshot.entries.map(e => e.phoneE164)]);
    const matched = matchSuppressionSnapshot(snapshot, lookup.rows);
    if (matched.unmatched.length) throw new Error('Suppression import blocked: one or more numbers do not safely match an existing company/person phone point.');
    let inserted = 0;
    const manifest = JSON.stringify({ sourceKey:snapshot.sourceKey, completenessStatus:snapshot.completenessStatus,
      capturedAt:snapshot.capturedAt, duplicateCount:snapshot.duplicateCount, inputCount:snapshot.inputCount });
    for (const { entry, point } of matched.matches) {
      let evId = (await client.query(
        `SELECT id FROM lead_intel.source_evidence WHERE company_id=$1 AND contact_id IS NOT DISTINCT FROM $2 AND source_id=$3
         AND evidence_type='OTHER' AND source_url=$4 AND evidence_text=$5 AND source_published_at=$6 LIMIT 1`,
        [point.company_id, point.contact_id, sourceId, snapshot.sourceUrl, manifest, snapshot.capturedAt])).rows[0]?.id;
      if (!evId) evId = (await client.query(
        `INSERT INTO lead_intel.source_evidence(company_id,contact_id,source_id,evidence_type,source_url,evidence_text,access_policy_snapshot,source_published_at)
         VALUES($1,$2,$3,'OTHER',$4,$5,'USER_PROVIDED_COMPLETE_SUPPRESSION_SNAPSHOT',$6) RETURNING id`,
        [point.company_id, point.contact_id, sourceId, snapshot.sourceUrl, manifest, snapshot.capturedAt])).rows[0].id;
      const exists = await client.query(`SELECT 1 FROM lead_intel.suppression WHERE company_id=$1 AND contact_point_id=$2
        AND suppression_type='DO_NOT_CONTACT' AND source_evidence_id=$3 LIMIT 1`, [point.company_id, point.id, evId]);
      if (!exists.rowCount) {
        const result = await client.query(
          `INSERT INTO lead_intel.suppression(company_id,contact_id,contact_point_id,channel,suppression_type,reason,source_evidence_id,recorded_by)
           VALUES($1,$2,$3,'PHONE','DO_NOT_CONTACT','Complete suppression snapshot import',$4,$5) RETURNING id`,
          [point.company_id, point.contact_id, point.id, evId, snapshot.sourceKey]);
        inserted += result.rowCount;
      }
    }
    await client.query('COMMIT');
    return { matched:matched.matches.length, inserted, duplicateNumbers:snapshot.duplicateCount,
      unmatched:0, completenessStatus:snapshot.completenessStatus, capturedAt:snapshot.capturedAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function persistNormalization(client, preview, { approvedPlanSha256, confirmImport = false, environment } = {}) {
  if (environment !== 'DISPOSABLE') throw new Error('Normalization writes are allowed only against the DISPOSABLE database.');
  if (confirmImport !== true || approvedPlanSha256 !== preview?.planSha256) throw new Error('Normalization requires approval of the exact dry-run plan.');
  if (!preview.rows.length || preview.counts.identityConflicts) throw new Error('Normalization blocked by empty input or company identity conflict.');
  const { rows, spreadsheetId } = preview;
  const sourceKey = `${SOURCE_KEY_PREFIX}${spreadsheetId}`;
  await client.query('BEGIN');
  try {
  const sourceRows = await client.query(
    `INSERT INTO lead_intel.sources(source_key,display_name,source_type,base_url,permission_status,permission_notes,enabled)
     VALUES($1,'Existing Google Sheets Prospects snapshot','USER_PROVIDED',$2,'MANUAL_ONLY','Read-only source snapshot; no discovery permission',false)
     ON CONFLICT(source_key) DO NOTHING RETURNING id`, [sourceKey, `https://docs.google.com/spreadsheets/d/${spreadsheetId}`]);
  let sourceId = sourceRows.rows[0]?.id;
  if (!sourceId) sourceId = (await client.query('SELECT id FROM lead_intel.sources WHERE source_key=$1', [sourceKey])).rows[0]?.id;
  if (!sourceId) throw new Error('Could not resolve the snapshot provenance source.');
  const stats = { companiesCreated: 0, companiesReused: 0, locationsCreated: 0, contactsCreated: 0,
    companyContactPointsCreated: 0, personContactPointsCreated: 0, sourceEvidenceCreated: 0, fieldEvidenceCreated: 0, reviewJobsCreated: 0 };
  const evidenceIds = new Map();
  async function evidence(companyId, contactId, url, type, snapshotId, fieldKey) {
    const safeUrl = validHttpUrl(url); if (!safeUrl) return null;
    const digest = hash(`${spreadsheetId}\0${snapshotId}\0${fieldKey}\0${safeUrl}`);
    const key = `${companyId}:${contactId || ''}:${type}:${digest}`;
    if (evidenceIds.has(key)) return evidenceIds.get(key);
    let found = await client.query(
      `SELECT id FROM lead_intel.source_evidence WHERE company_id=$1 AND contact_id IS NOT DISTINCT FROM $2
       AND source_id=$3 AND evidence_type=$4 AND source_url=$5 AND content_sha256=$6 LIMIT 1`,
      [companyId, contactId || null, sourceId, type, safeUrl, digest]);
    let id = found.rows[0]?.id;
    if (!id) {
      const inserted = await client.query(
        `INSERT INTO lead_intel.source_evidence(company_id,contact_id,source_id,evidence_type,source_url,access_policy_snapshot,content_sha256)
         VALUES($1,$2,$3,$4,$5,'USER_PROVIDED_SHEET_SOURCE_URL',$6) RETURNING id`,
        [companyId, contactId || null, sourceId, type, safeUrl, digest]);
      id = inserted.rows[0].id; stats.sourceEvidenceCreated += 1;
    }
    evidenceIds.set(key, id);
    return id;
  }
    for (const item of rows) {
      const { record: r } = item;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${spreadsheetId}:${r.leadId}`]);
      let companyId = (await client.query(
        `SELECT company_id FROM lead_intel.company_identifiers WHERE identifier_namespace=$1 AND identifier_type='APPS_SCRIPT_LEAD_ID' AND normalized_value=$2`,
        [sourceKey, r.leadId])).rows[0]?.company_id;
      if (!companyId) {
        const exact = await client.query(`SELECT id FROM lead_intel.companies WHERE lower(canonical_name)=lower($1)`, [r.companyName]);
        if (exact.rowCount) throw new Error('Existing company name collision appeared after dry run; aborting the transaction.');
        const score = Number(r.icpScore);
        const company = await client.query(
          `INSERT INTO lead_intel.companies(canonical_name,website_url,primary_domain,industry,icp_score,status,headquarters_state_code)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [r.companyName, validHttpUrl(r.companyWebsite) || null, item.domain || null, r.industry || null,
            Number.isFinite(score) ? score : null, item.qualificationStatus === 'ELIGIBLE_EXISTING_ONLY' ? 'QUALIFIED' : 'NEEDS_REVIEW',
            item.location.stateCode]);
        companyId = company.rows[0].id; stats.companiesCreated += 1;
        await client.query(
          `INSERT INTO lead_intel.company_identifiers(company_id,identifier_type,identifier_namespace,raw_value,normalized_value,source_id,source_url)
           VALUES($1,'APPS_SCRIPT_LEAD_ID',$2,$3,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [companyId, sourceKey, r.leadId, sourceId, validHttpUrl(r.sourceUrl) || null]);
        if (item.domain) await client.query(
          `INSERT INTO lead_intel.company_identifiers(company_id,identifier_type,identifier_namespace,raw_value,normalized_value,source_id,source_url)
           VALUES($1,'WEBSITE_DOMAIN','official-website',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [companyId, r.companyDomain || item.domain, item.domain, sourceId, validHttpUrl(r.sourceUrl) || null]);
      } else {
        const current = await client.query('SELECT canonical_name FROM lead_intel.companies WHERE id=$1', [companyId]);
        if (!current.rows[0] || String(current.rows[0].canonical_name).toLowerCase() !== r.companyName.toLowerCase()) throw new Error('Lead ID already maps to a different company name; aborting safely.');
        stats.companiesReused += 1;
      }

      await evidence(companyId, null, r.sourceUrl, 'COMPANY_IDENTITY', item.snapshotId, 'company');
      const locationEvidence = item.location.city || item.location.address ? await evidence(companyId, null, r.sourceUrl, 'LOCATION', item.snapshotId, 'location') : null;
      for (const [fieldKey, value] of Object.entries(r)) {
        if (!value || !SOURCE_FIELDS[fieldKey]) continue;
        const sourceField = SOURCE_FIELDS[fieldKey];
        const url = validHttpUrl(r[sourceField]);
        if (!url) continue;
        const type = ['pocName','designation','department'].includes(fieldKey) ? 'CONTACT_IDENTITY' :
          ['arizonaCity','arizonaAddress'].includes(fieldKey) ? 'LOCATION' :
          ['companyEmail','pocEmailId','companyContactNumber','pocContactNumber','liPocProfile'].includes(fieldKey) ? 'CONTACT_POINT' :
          fieldKey === 'employeeSize' ? 'EMPLOYEE_SIZE' : fieldKey === 'industry' ? 'INDUSTRY' : 'OTHER';
        const evId = await evidence(companyId, null, url, type, item.snapshotId, fieldKey);
        const valueHash = hash(value);
        const idem = hash(`${spreadsheetId}\0${r.leadId}\0${fieldKey}\0${valueHash}\0${url}`);
        const fieldEvidence = await client.query(
          `INSERT INTO lead_intel.field_evidence(company_id,field_key,source_evidence_id,observed_value_sha256,idempotency_key,observed_at)
           VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
          [companyId, fieldKey, evId, valueHash, idem]);
        stats.fieldEvidenceCreated += fieldEvidence.rowCount;
      }
      if (item.location.stateCode && (item.location.city || item.location.address)) {
        const loc = await client.query(
          `SELECT id FROM lead_intel.company_locations WHERE company_id=$1 AND state_code='AZ' AND city IS NOT DISTINCT FROM $2
           AND postal_code IS NOT DISTINCT FROM $3 AND address_line_1 IS NOT DISTINCT FROM $4 LIMIT 1`,
          [companyId, item.location.city, item.location.postalCode, item.location.address]);
        if (!loc.rowCount) {
          await client.query(
            `INSERT INTO lead_intel.company_locations(company_id,location_type,address_line_1,city,state_code,postal_code,country_code,is_primary,source_evidence_id)
             VALUES($1,'UNKNOWN',$2,$3,'AZ',$4,'US',false,$5)`,
            [companyId, item.location.address, item.location.city, item.location.postalCode, locationEvidence]);
          stats.locationsCreated += 1;
        }
      }

      let contactId = null;
      if (r.pocName) {
        const existingContact = await client.query('SELECT id FROM lead_intel.contacts WHERE company_id=$1 AND lower(full_name)=lower($2) ORDER BY id LIMIT 1', [companyId, r.pocName]);
        if (existingContact.rowCount) contactId = existingContact.rows[0].id;
        else {
          const inserted = await client.query('INSERT INTO lead_intel.contacts(company_id,full_name,normalized_name,job_title,department) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [companyId, r.pocName, r.pocName.toLowerCase(), r.designation || null, r.department || null]);
          contactId = inserted.rows[0].id; stats.contactsCreated += 1;
        }
        if (validHttpUrl(r.contactSourceUrl)) {
          const contactEvidence = await evidence(companyId, contactId, r.contactSourceUrl, 'CONTACT_IDENTITY', item.snapshotId, 'poc-identity');
          await client.query('UPDATE lead_intel.contacts SET source_evidence_id=$2 WHERE id=$1 AND source_evidence_id IS NULL', [contactId, contactEvidence]);
        }
      }

      const pointSpecs = [
        { scope:'COMPANY', channel:'EMAIL', value:r.companyEmail, source:r.companyEmailSourceUrl, syntax:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.companyEmail), pointField:'companyEmail' },
        { scope:'COMPANY', channel:'PHONE', value:r.companyContactNumber, source:r.companyPhoneSourceUrl, pointField:'companyContactNumber' },
        { scope:'PERSON', channel:'EMAIL', value:r.pocEmailId, source:r.pocEmailSourceUrl, syntax:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.pocEmailId), pointField:'pocEmailId' },
        { scope:'PERSON', channel:'PHONE', value:r.pocContactNumber, source:r.pocPhoneSourceUrl, pointField:'pocContactNumber' },
        { scope:'PERSON', channel:'LINKEDIN', value:r.liPocProfile, source:r.linkedInSourceUrl, pointField:'liPocProfile' }
      ];
      for (const spec of pointSpecs) {
        if (!spec.value || (spec.scope === 'PERSON' && !contactId)) continue;
        const url = validHttpUrl(spec.source);
        const evId = url ? await evidence(companyId, spec.scope === 'PERSON' ? contactId : null, url, 'CONTACT_POINT', item.snapshotId, spec.pointField) : null;
        let normalized = spec.channel === 'EMAIL' ? spec.value.toLowerCase() : spec.channel === 'PHONE' ? (normalizeUsPhone(spec.value).e164 || spec.value.replace(/\D/g, '') || spec.value.trim()) : (validHttpUrl(spec.value) || spec.value.trim());
        const old = await client.query(
          `SELECT id FROM lead_intel.contact_points WHERE company_id=$1 AND scope_kind=$2 AND contact_id IS NOT DISTINCT FROM $3 AND channel=$4 AND normalized_value=$5 LIMIT 1`,
          [companyId, spec.scope, spec.scope === 'PERSON' ? contactId : null, spec.channel, normalized]);
        if (old.rowCount) continue;
        const format = spec.channel === 'PHONE' ? (normalizeUsPhone(spec.value).e164 ? 'VALID_FORMAT' : 'INVALID') : null;
        const mx = spec.channel === 'EMAIL' ? (['MX_PRESENT','NO_MX','UNKNOWN','NOT_CHECKED'].includes(r.emailDomainMxStatus) ? r.emailDomainMxStatus : 'UNVERIFIED') : null;
        const syntax = spec.channel === 'EMAIL' ? (spec.syntax ? 'VALID_FORMAT' : 'INVALID') : null;
        const emailSyntax = spec.channel === 'EMAIL' ? syntax : null;
        const emailMx = spec.channel === 'EMAIL' ? (mx || 'UNVERIFIED') : null;
        const deliverability = spec.channel === 'EMAIL' ? 'UNVERIFIED' : null;
        const phoneFormat = spec.channel === 'PHONE' ? format : null;
        const activity = spec.channel === 'PHONE' ? 'UNVERIFIED' : null;
        const inserted = await client.query(
          `INSERT INTO lead_intel.contact_points(company_id,scope_kind,contact_id,channel,raw_value,normalized_value,source_evidence_id,is_publicly_listed,
             email_syntax_status,email_mx_status,email_deliverability_status,phone_format_status,phone_activity_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [companyId, spec.scope, spec.scope === 'PERSON' ? contactId : null, spec.channel, spec.value, normalized, evId, Boolean(evId),
            emailSyntax, emailMx, deliverability, phoneFormat, activity]);
        if (inserted.rowCount) {
          if (spec.scope === 'COMPANY') stats.companyContactPointsCreated += 1;
          else stats.personContactPointsCreated += 1;
        }
      }

      for (const issue of item.issues) {
        const key = hash(`normalization-review\0${spreadsheetId}\0${r.leadId}\0${issue}`);
        const job = await client.query(
          `INSERT INTO lead_intel.jobs(job_type,status,idempotency_key,payload,max_attempts)
           VALUES('MANUAL_REVIEW','QUEUED',$1,$2::jsonb,1) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
          [key, JSON.stringify({ kind:'EXISTING_PROSPECT_QUALITY_REVIEW', leadId:r.leadId, snapshotId:item.snapshotId, issueCode:issue })]);
        stats.reviewJobsCreated += job.rowCount;
      }
    }
    await client.query('COMMIT');
    return stats;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { SOURCE_KEY_PREFIX, clean, validHttpUrl, hash, mapCells, parseSnapshotRow,
  buildNormalizationPreview, normalizeSuppressionSnapshot, assertSuppressionImportable, matchSuppressionSnapshot,
  persistSuppressionSnapshot, persistNormalization };
