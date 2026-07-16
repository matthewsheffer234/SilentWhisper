import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { assertBoundedInt, assertUuid } from '../validation.js';
import { ValidationError } from '../errors.js';
import {
  getMentionSummary,
  listMentionNotifications,
  markAllMentionNotificationsRead,
  markMentionNotificationRead,
} from '../services/mentionNotificationService.js';
import { getUnreadUserNotificationCount } from '../services/userNotificationService.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseNotificationQuery(query) {
  const limit =
    query.limit !== undefined
      ? assertBoundedInt(query.limit, { min: 1, max: MAX_LIMIT }, 'limit')
      : DEFAULT_LIMIT;
  const before = query.before ? new Date(String(query.before)) : null;
  if (before && Number.isNaN(before.getTime())) {
    throw new ValidationError('before must be a valid timestamp');
  }
  const unreadOnly = query.unreadOnly === 'true' || query.unreadOnly === '1';
  return { limit, before: before?.toISOString(), unreadOnly };
}

// unreadCount is combined (mentions + membership-invitation alerts) — the
// single value the sidebar's badge trigger renders (WorkspaceSidebar.jsx).
// mentionUnreadCount/membershipInvitationUnreadCount are kept alongside it,
// additively, for anything that needs to distinguish the two (e.g.
// NotificationPanel's two sections) without a second round trip. Shared by
// both GET /mentions and GET /summary so opening the mentions list never
// clobbers the sidebar's combined badge back down to a mentions-only count.
async function getCombinedSummary(db, userId) {
  const mentionSummary = await getMentionSummary(db, userId);
  const membershipInvitationUnreadCount = await getUnreadUserNotificationCount(db, userId);
  return {
    ...mentionSummary,
    mentionUnreadCount: mentionSummary.unreadCount,
    membershipInvitationUnreadCount,
    unreadCount: mentionSummary.unreadCount + membershipInvitationUnreadCount,
  };
}

notificationsRouter.get('/mentions', async (req, res, next) => {
  try {
    const notifications = await listMentionNotifications(db, req.user.id, parseNotificationQuery(req.query));
    const summary = await getCombinedSummary(db, req.user.id);
    res.json({ notifications, summary });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await getCombinedSummary(db, req.user.id));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/mentions/:id/read', async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    res.json(await markMentionNotificationRead(db, req.user.id, id));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/mentions/read-all', async (req, res, next) => {
  try {
    res.json(await markAllMentionNotificationsRead(db, req.user.id));
  } catch (err) {
    next(err);
  }
});
