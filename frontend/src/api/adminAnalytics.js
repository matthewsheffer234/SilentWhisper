import { apiFetch } from './client.js';

// FEATURE_REQUEST.md entry 5 (Admin Analytics Dashboard — activity and
// engagement metrics). scope/scopeId are a matched pair, matching the
// backend's own parseScope — omit both for "every organization."
export const getAnalyticsActivity = ({ scope, scopeId, windowDays, bucket } = {}) => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scopeId) params.set('scopeId', scopeId);
  if (windowDays) params.set('windowDays', windowDays);
  if (bucket) params.set('bucket', bucket);
  const qs = params.toString();
  return apiFetch(`/admin/analytics/activity${qs ? `?${qs}` : ''}`);
};

export const getDormantChannels = ({ windowDays } = {}) => {
  const params = new URLSearchParams();
  if (windowDays) params.set('windowDays', windowDays);
  const qs = params.toString();
  return apiFetch(`/admin/analytics/dormant-channels${qs ? `?${qs}` : ''}`);
};
