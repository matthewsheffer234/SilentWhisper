import { apiFetch, fetchAllPages } from './client.js';

export const listMentionNotifications = ({ unreadOnly, limit, before } = {}) => {
  const params = new URLSearchParams();
  if (unreadOnly) params.set('unreadOnly', 'true');
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', before);
  const qs = params.toString();
  return apiFetch(`/notifications/mentions${qs ? `?${qs}` : ''}`);
};

export const getNotificationSummary = () => apiFetch('/notifications/summary');

export const markMentionNotificationRead = (id) =>
  apiFetch(`/notifications/mentions/${id}/read`, { method: 'PATCH' });

export const markAllMentionNotificationsRead = () =>
  apiFetch('/notifications/mentions/read-all', { method: 'POST' });

// Membership invitations (FEATURE_REQUEST.md "Live notification system..."):
// an existing account's own pending invitations, distinct from
// api/invitations.js's token-based ones.
//
// Finding 3, docs/reviews/security-performance-review-2026-07-20.md: now
// offset-paginated server-side; looped into a flat list for
// NotificationPanel.jsx's existing rendering rather than adding pager UI to
// a notification dropdown.
export const listMembershipInvitations = () => fetchAllPages('/membership-invitations', 'invitations');
export const acceptMembershipInvitation = (id) => apiFetch(`/membership-invitations/${id}/accept`, { method: 'POST' });
export const declineMembershipInvitation = (id) =>
  apiFetch(`/membership-invitations/${id}/decline`, { method: 'POST' });
