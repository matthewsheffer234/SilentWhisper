import { apiFetch } from './client.js';

// `id` comes back from the backend as a string (Postgres BIGSERIAL —
// node-postgres returns int8 columns as strings to avoid silent precision
// loss beyond 2^53). Treat it as an opaque pagination cursor here, never do
// arithmetic on it — same convention the backend itself uses.
export const getAuditLogs = ({ limit, beforeId } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (beforeId) params.set('beforeId', beforeId);
  const qs = params.toString();
  return apiFetch(`/audit/logs${qs ? `?${qs}` : ''}`);
};

export const verifyAuditLog = () => apiFetch('/audit/verify', { method: 'POST' });
