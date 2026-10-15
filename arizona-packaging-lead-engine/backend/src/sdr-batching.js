'use strict';

const { inspectExistingProspect, normalizeUsPhone } = require('./quality');

const DEFAULT_AGENTS = Object.freeze(['sdr-1', 'sdr-2', 'sdr-3']);

function buildSdrBatches(records, { campaignId, agents = DEFAULT_AGENTS, perAgent = 150, suppressions = [],
  suppressionSnapshot = null, verificationPolicy = null, now = new Date() } = {}) {
  if (!campaignId || !Array.isArray(agents) || agents.length !== 3 || new Set(agents).size !== 3) {
    throw new Error('Campaign ID and exactly three unique SDR agents are required.');
  }
  if (!Number.isInteger(perAgent) || perAgent < 1) throw new Error('perAgent must be a positive integer.');
  const policyReady = Boolean(verificationPolicy && verificationPolicy.requireIndependentActive === true &&
    Number.isInteger(verificationPolicy.maxAgeDays) && verificationPolicy.maxAgeDays > 0);
  const snapshotValid = Boolean(suppressionSnapshot && suppressionSnapshot.validated === true &&
    suppressionSnapshot.completenessStatus === 'COMPLETE' && suppressionSnapshot.sourceKey &&
    suppressionSnapshot.sourceUrl && Number.isFinite(Date.parse(suppressionSnapshot.capturedAt)) && Array.isArray(suppressionSnapshot.entries));
  const snapshotSuppressions = snapshotValid ? suppressionSnapshot.entries.flatMap(entry => [entry.phoneE164, entry.leadId]).filter(Boolean) : [];
  const suppressed = new Set([...suppressions, ...snapshotSuppressions].map((item) => String(item).trim().toLowerCase()));
  const seenPhones = new Set();
  const candidatePhones = new Set();
  const eligible = [];
  const excluded = { unqualified: 0, missingPhone: 0, invalidPhone: 0, missingSource: 0, suppressed: 0,
    duplicatePhone: 0, insufficientVerification: 0 };

  for (const record of records) {
    const audit = inspectExistingProspect(record);
    if (audit.qualificationStatus !== 'ELIGIBLE_EXISTING_ONLY') { excluded.unqualified += 1; continue; }
    let rawPhone = record.pocContactNumber;
    let scope = 'PERSON';
    let sourceUrl = record.pocPhoneSourceUrl;
    if (!rawPhone) { rawPhone = record.companyContactNumber; scope = 'COMPANY'; sourceUrl = record.companyPhoneSourceUrl; }
    if (!rawPhone) { excluded.missingPhone += 1; continue; }
    const normalized = normalizeUsPhone(rawPhone);
    if (!normalized.e164 || record.phoneFormatStatus === 'INVALID') { excluded.invalidPhone += 1; continue; }
    if (!/^https?:\/\//i.test(String(sourceUrl || '').trim())) { excluded.missingSource += 1; continue; }
    candidatePhones.add(normalized.e164);
    if (suppressed.has(String(record.leadId).toLowerCase()) || suppressed.has(normalized.e164.toLowerCase())) {
      excluded.suppressed += 1; continue;
    }
    if (seenPhones.has(normalized.e164)) { excluded.duplicatePhone += 1; continue; }
    seenPhones.add(normalized.e164);
    const checkedAt = Date.parse(record.phoneVerifiedAt || '');
    const maxAgeMs = policyReady ? verificationPolicy.maxAgeDays * 86400000 : 0;
    const independentlyActive = policyReady && record.phoneActivityIndependentlyVerified === true &&
      String(record.phoneActivityStatus || '').toUpperCase() === 'ACTIVE' && Number.isFinite(checkedAt) &&
      checkedAt <= now.getTime() && now.getTime() - checkedAt <= maxAgeMs;
    if (!independentlyActive) { excluded.insufficientVerification += 1; continue; }
    eligible.push({ leadId: record.leadId, companyName: record.companyName, phoneE164: normalized.e164,
      phoneScope: scope, phoneSourceUrl: sourceUrl, phoneActivityStatus: 'ACTIVE',
      phoneFormatStatus: 'VALID_FORMAT', requiresReview: false });
  }

  eligible.sort((a, b) => a.leadId.localeCompare(b.leadId));
  const batches = Object.fromEntries(agents.map((agent) => [agent, []]));
  const selected = eligible.slice(0, perAgent * agents.length);
  const assignmentReady = snapshotValid && policyReady;
  if (assignmentReady) selected.forEach((lead, index) => batches[agents[index % agents.length]].push(lead));
  const assigned = assignmentReady ? selected.length : 0;
  const shortage = Object.fromEntries(agents.map((agent) => [agent, Math.max(0, perAgent - batches[agent].length)]));
  return Object.freeze({ campaignId, perAgent, eligibleUniquePhones: policyReady ? eligible.length : null,
    uniquePhoneCandidatesBeforeSuppressionReview: candidatePhones.size,
    verificationCandidates: eligible.length,
    suppressionStatus: snapshotValid ? 'RECONCILED' : 'BLOCKED_NEEDS_COMPLETE_SUPPRESSION_SNAPSHOT',
    verificationPolicyStatus: policyReady ? 'CONFIGURED' : 'BLOCKED_NEEDS_VERIFICATION_POLICY', assigned,
    totalShortage: Object.values(shortage).reduce((sum, count) => sum + count, 0), shortage, excluded, batches,
    noOutreachSent: true });
}

module.exports = { DEFAULT_AGENTS, buildSdrBatches };
