'use strict';

const ALLOWED_EMAIL = new Set(['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'INVALID', 'UNKNOWN']);
const ALLOWED_PHONE = new Set(['ACTIVE', 'INACTIVE', 'INVALID', 'UNKNOWN']);

function createVerificationService({ providers = {}, env = process.env, now = () => new Date() } = {}) {
  const enabled = env.WORKER_VERIFICATION_ENABLED === 'true' && env.VERIFICATION_PROVIDER_ENABLED === 'true';
  const maxCost = Number(env.VERIFICATION_MAX_COST_USD || 0);
  let spent = 0;
  async function verify({ channel, contactPoint, costUsd = 0 }) {
    if (!['EMAIL', 'PHONE'].includes(channel)) throw new Error('Unsupported verification channel.');
    if (!enabled) return Object.freeze({ status: 'UNVERIFIED', provider: 'DISABLED', independentlyVerified: false, checkedAt: now().toISOString() });
    if (!Number.isFinite(maxCost) || maxCost <= 0 || !Number.isFinite(costUsd) || costUsd <= 0 || spent + costUsd > maxCost) {
      return Object.freeze({ status: 'UNVERIFIED', provider: 'COST_CAP_BLOCKED', independentlyVerified: false, checkedAt: now().toISOString() });
    }
    const provider = providers[channel];
    if (!provider || typeof provider.verify !== 'function') return Object.freeze({ status: 'UNVERIFIED', provider: 'NO_APPROVED_ADAPTER', independentlyVerified: false, checkedAt: now().toISOString() });
    spent += costUsd;
    const result = await provider.verify({ value: contactPoint.normalized_value, channel });
    const valid = channel === 'EMAIL' ? ALLOWED_EMAIL : ALLOWED_PHONE;
    const status = valid.has(result?.status) ? result.status : 'UNKNOWN';
    const independent = result?.independent === true && Boolean(result?.providerId);
    const activeOutcome = channel === 'EMAIL' ? status === 'DELIVERABLE' : status === 'ACTIVE';
    return Object.freeze({ status: activeOutcome && !independent ? 'UNKNOWN' : status,
      provider: String(result?.providerId || 'UNKNOWN_PROVIDER').slice(0, 80), independentlyVerified: independent,
      checkedAt: now().toISOString(), freshUntil: result?.freshUntil && Number.isFinite(Date.parse(result.freshUntil)) ? new Date(result.freshUntil).toISOString() : null,
      costUsd });
  }
  return Object.freeze({ verify, get spentUsd() { return spent; }, enabled });
}

module.exports = { createVerificationService };
