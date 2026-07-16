// Generalized notification alert log (FEATURE_REQUEST.md "Live notification
// system..."), a sibling to mentionNotificationService.js's mention-specific
// table rather than a replacement for it — same "durable unread state
// without touching the underlying object's own table" shape, applied to
// membership invitations instead of messages.
//
// This table tracks *alert* state (has the recipient seen this?), which is
// deliberately separate from a membership_invitations row's own PENDING/
// ACCEPTED/DECLINED lifecycle: a user can see (and dismiss) an invite alert
// without yet deciding whether to accept or decline the invitation itself.

export async function createUserNotification(db, { recipientUserId, type, payload }) {
  const [row] = await db('user_notifications')
    .insert({ recipient_user_id: recipientUserId, type, payload: JSON.stringify(payload ?? {}) })
    .returning(['id']);
  return row;
}

export async function getUnreadUserNotificationCount(db, userId) {
  const row = await db('user_notifications')
    .where({ recipient_user_id: userId })
    .whereNull('read_at')
    .first(db.raw('COUNT(*)::int AS count'));
  return row?.count ?? 0;
}

// Best-effort: called after an accept/decline resolves the underlying
// membership_invitations row, so the alert clears from the badge even if the
// recipient never explicitly opened/dismissed it. Matches on the payload's
// own membershipInvitationId rather than a foreign key, since this table is
// intentionally generic across notification types.
export async function markMembershipInvitationNotificationRead(db, userId, membershipInvitationId) {
  await db('user_notifications')
    .where({ recipient_user_id: userId })
    .whereIn('type', ['ORG_INVITE', 'WORKSPACE_INVITE'])
    .whereRaw("payload->>'membershipInvitationId' = ?", [membershipInvitationId])
    .whereNull('read_at')
    .update({ read_at: db.fn.now() });
}
