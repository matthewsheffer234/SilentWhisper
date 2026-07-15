import { apiFetch } from './client.js';

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
