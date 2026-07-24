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

// FEATURE_REQUEST.md entry 4: editable entity metadata, entity_relationships,
// and the AI-generated "What we know" summary.
export const updateEntity = (workspaceId, entityId, patch) =>
  apiFetch(`/workspaces/${workspaceId}/entities/${entityId}`, { method: 'PATCH', body: patch });

export const createEntityRelationship = (workspaceId, entityId, { targetEntityId, relationshipType }) =>
  apiFetch(`/workspaces/${workspaceId}/entities/${entityId}/relationships`, {
    method: 'POST',
    body: { targetEntityId, relationshipType },
  });

export const deleteEntityRelationship = (workspaceId, entityId, relationshipId) =>
  apiFetch(`/workspaces/${workspaceId}/entities/${entityId}/relationships/${relationshipId}`, { method: 'DELETE' });

export const getEntitySummary = (workspaceId, entityId) =>
  apiFetch(`/workspaces/${workspaceId}/entities/${entityId}/ai/summary`);

export const generateEntitySummary = (workspaceId, entityId) =>
  apiFetch(`/workspaces/${workspaceId}/entities/${entityId}/ai/summary`, { method: 'POST' });
