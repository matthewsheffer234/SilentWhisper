import { apiFetch } from './client.js';

export const searchEntities = (workspaceId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/entities/search${qs ? `?${qs}` : ''}`);
};

export const resolveEntity = (workspaceId, name) => {
  const params = new URLSearchParams({ name });
  return apiFetch(`/workspaces/${workspaceId}/entities/resolve?${params.toString()}`);
};

export const getEntity = (workspaceId, entityId) => apiFetch(`/workspaces/${workspaceId}/entities/${entityId}`);

export const listEntityReferences = (workspaceId, entityId, { limit, before } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (before) params.set('before', before);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/entities/${entityId}/references${qs ? `?${qs}` : ''}`);
};
