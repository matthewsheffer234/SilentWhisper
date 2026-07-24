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

// Admin Analytics Dashboard, collaboration tab. scope is restricted to
// organization|workspace server-side (a channel-scoped membership overlap
// is just that one channel's own roster, not a cross-channel bridge
// signal) — the frontend scope selector for this tab omits "Channel"
// accordingly rather than letting the request 400.
export const getMembershipGraph = ({ scope, scopeId, minSharedChannels } = {}) => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scopeId) params.set('scopeId', scopeId);
  if (minSharedChannels !== undefined) params.set('minSharedChannels', minSharedChannels);
  const qs = params.toString();
  return apiFetch(`/admin/analytics/collaboration/membership-graph${qs ? `?${qs}` : ''}`);
};

export const getInteractionTrend = ({ scope, scopeId, windowDays, bucket } = {}) => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scopeId) params.set('scopeId', scopeId);
  if (windowDays) params.set('windowDays', windowDays);
  if (bucket) params.set('bucket', bucket);
  const qs = params.toString();
  return apiFetch(`/admin/analytics/collaboration/interaction-trend${qs ? `?${qs}` : ''}`);
};

// Admin Analytics Dashboard, sentiment tab. scope additionally allows
// `user` — the sharper privacy tradeoff the panel's own caveat banner
// calls out when selected (server-side, an `AI_SENTIMENT_TREND_VIEWED`
// audit row is written only for this scope).
export const getSentimentTrend = ({ scope, scopeId, windowDays, bucket } = {}) => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scopeId) params.set('scopeId', scopeId);
  if (windowDays) params.set('windowDays', windowDays);
  if (bucket) params.set('bucket', bucket);
  const qs = params.toString();
  return apiFetch(`/admin/analytics/sentiment-trend${qs ? `?${qs}` : ''}`);
};
