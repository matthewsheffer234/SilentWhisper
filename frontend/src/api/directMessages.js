import { apiFetch, fetchAllPages } from './client.js';

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section). createDirectMessage previously lived in workspaces.js despite
// DMs being workspace-independent (channels.workspace_id is NULL for
// DIRECT/GROUP_DM, PROJECT_PLAN.md Section 4) — moved here alongside the
// rest of the DM surface now that one exists.
//
// FEATURE_REQUEST.md entry 2: GET /direct-messages is now offset-paginated
// server-side; this loops every page into the flat list the sidebar
// renders, rather than pushing pager UI onto DM navigation.
export const listDirectMessages = () => fetchAllPages('/direct-messages', 'directMessages');
export const createDirectMessage = (targetUserId) =>
  apiFetch('/direct-messages', { method: 'POST', body: { targetUserId } });
export const createGroupDirectMessage = (memberIds) =>
  apiFetch('/group-direct-messages', { method: 'POST', body: { memberIds } });
