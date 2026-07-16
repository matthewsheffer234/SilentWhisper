import { apiFetch } from './client.js';

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section). createDirectMessage previously lived in workspaces.js despite
// DMs being workspace-independent (channels.workspace_id is NULL for
// DIRECT/GROUP_DM, PROJECT_PLAN.md Section 4) — moved here alongside the
// rest of the DM surface now that one exists.
export const listDirectMessages = () => apiFetch('/direct-messages');
export const createDirectMessage = (targetUserId) =>
  apiFetch('/direct-messages', { method: 'POST', body: { targetUserId } });
export const createGroupDirectMessage = (memberIds) =>
  apiFetch('/group-direct-messages', { method: 'POST', body: { memberIds } });
