import { apiFetch, fetchAllPages } from './client.js';

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section). createDirectMessage previously lived in workspaces.js despite
// DMs being workspace-independent (channels.workspace_id is NULL for
// DIRECT/GROUP_DM, PROJECT_PLAN.md Section 4) — moved here alongside the
// rest of the DM surface now that one exists.
//
// FEATURE_REQUEST.md entry 2: GET /direct-messages is now offset-paginated
// server-side; this loops every page into the flat list the sidebar
// renders, rather than pushing pager UI onto DM navigation. Finding 4,
// docs/reviews/security-performance-review-2026-07-20.md: optional `onPage`
// callback (see api/workspaces.js's listWorkspaces) so the sidebar can
// render the first page immediately instead of waiting on every page.
export const listDirectMessages = (onPage) => fetchAllPages('/direct-messages', 'directMessages', { onPage });
export const createDirectMessage = (targetUserId) =>
  apiFetch('/direct-messages', { method: 'POST', body: { targetUserId } });
export const createGroupDirectMessage = (memberIds) =>
  apiFetch('/group-direct-messages', { method: 'POST', body: { memberIds } });
