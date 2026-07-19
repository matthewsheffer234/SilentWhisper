// Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry 6).
// Source selection for the digest prompt: unread mentions plus messages from
// an explicit set of caller-chosen channels, both scoped to the requested
// workspace and time window.
//
// Scope decision (documented in PROJECT_PLAN.md Section 11): the original
// design offered a persisted starred_channels table as one option, or "an
// explicit channel list" left as the v1 fallback if that table doesn't exist
// yet. This implementation takes the explicit-list fallback — channelIds is
// caller-supplied per request, not a durable per-user preference — since a
// full first-class starring feature (schema, toggle endpoints, UI) is a
// separable concern the design itself flags as optional.

export const DIGEST_MAX_CHANNELS = 10;
const DIGEST_MAX_MESSAGES_PER_CHANNEL = 100;
const DIGEST_MAX_TOTAL_MESSAGES = 400;

// Mirrors mentionNotificationService.js's baseVisibleNotificationsQuery: the
// live channel_members join is what keeps a mention from a channel the
// caller has since lost access to out of the digest (PROJECT_PLAN.md
// Section 3 — "no digest can leak messages from channels the caller cannot
// access"), the same stale-private-channel-access concern that entry's own
// bug fix closed for the mentions panel. Unread and non-dismissed only — a
// "catch up on what happened while I was away" digest has no reason to
// re-surface a mention already read or dismissed elsewhere.
//
// Shared by both the row-fetching and row-counting queries below so the two
// can never drift out of sync on which rows are actually in scope.
function mentionMessagesBaseQuery(db, { userId, workspaceId, since }) {
  return db('mention_notifications as mn')
    .join('messages as m', 'm.id', 'mn.message_id')
    .join('channels as c', 'c.id', 'mn.channel_id')
    .join('users as u', 'u.id', 'm.user_id')
    .join('channel_members as cm', function joinMembership() {
      this.on('cm.channel_id', '=', 'mn.channel_id').andOnVal('cm.user_id', '=', userId);
    })
    .where('mn.recipient_user_id', userId)
    .where('mn.workspace_id', workspaceId)
    .whereNull('mn.read_at')
    .whereNull('mn.dismissed_at')
    .where('mn.created_at', '>=', since);
}

// AI_DIGEST_MAX_WINDOW_HOURS defaults to 14 days, and nothing rate-limits
// how many times one user can be @mentioned — an ignored mention backlog (or
// mention spam) could otherwise force this to fully materialize and sort
// many thousands of rows before DIGEST_MAX_TOTAL_MESSAGES ever trims the
// result. Bound the SQL read itself to that same ceiling, keeping the most
// recent candidates (docs/reviews/security-performance-review-2026-07-19.md,
// Finding 2) — selectDigestMessages re-sorts chronologically after merging,
// so descending order here only affects which rows survive the cap, not the
// final output order.
async function selectMentionMessages(db, { userId, workspaceId, since }) {
  return mentionMessagesBaseQuery(db, { userId, workspaceId, since })
    .orderBy('mn.created_at', 'desc')
    .limit(DIGEST_MAX_TOTAL_MESSAGES)
    .select(
      'm.id as message_id',
      'm.content',
      'm.created_at',
      'c.name as channel_name',
      'u.username',
    );
}

// Cheap count for the audit payload's mentionCount field, kept separate from
// the now length-capped selectMentionMessages() result so that field still
// reflects the true number of matching mentions, not just how many survived
// the cap (same finding as above).
async function countMentionMessages(db, { userId, workspaceId, since }) {
  const result = await mentionMessagesBaseQuery(db, { userId, workspaceId, since })
    .count('mn.id as count')
    .first();
  return Number(result.count);
}

// Only channels the caller is currently a member of *and* that belong to
// this workspace are ever queried — a caller passing another workspace's
// channel id, or one they aren't (or are no longer) a member of, simply
// yields no rows for that id rather than an error (Section 3's
// existence-hiding convention, applied the same way entity references
// filter out channels the caller can't read).
async function selectChannelMessages(db, { userId, workspaceId, channelIds, since }) {
  if (!channelIds?.length) return [];

  const memberChannelRows = await db('channel_members as cm')
    .join('channels as c', 'c.id', 'cm.channel_id')
    .where('cm.user_id', userId)
    .where('c.workspace_id', workspaceId)
    .whereIn('c.id', channelIds)
    .select('c.id');
  const validChannelIds = memberChannelRows.map((r) => r.id);
  if (validChannelIds.length === 0) return [];

  return db('messages as m')
    .join('channels as c', 'c.id', 'm.channel_id')
    .join('users as u', 'u.id', 'm.user_id')
    .whereIn('m.channel_id', validChannelIds)
    .where('m.created_at', '>=', since)
    .orderBy('m.created_at', 'desc')
    .limit(validChannelIds.length * DIGEST_MAX_MESSAGES_PER_CHANNEL)
    .select(
      'm.id as message_id',
      'm.content',
      'm.created_at',
      'c.name as channel_name',
      'u.username',
    );
}

// Returns { messages, mentionCount, channelMessageCount } — messages is the
// deduplicated, chronologically-ascending, cap-bounded set ready to format
// into the digest prompt. mentionCount/channelMessageCount are the
// pre-dedupe source counts, kept separate purely for the audit payload
// (PROJECT_PLAN.md Section 6 — logging what was selected, never raw content).
export async function selectDigestMessages(db, { userId, workspaceId, since, channelIds }) {
  const [mentionRows, channelRows, mentionCount] = await Promise.all([
    selectMentionMessages(db, { userId, workspaceId, since }),
    selectChannelMessages(db, { userId, workspaceId, channelIds, since }),
    countMentionMessages(db, { userId, workspaceId, since }),
  ]);

  const byId = new Map();
  for (const row of [...mentionRows, ...channelRows]) {
    if (!byId.has(row.message_id)) {
      byId.set(row.message_id, row);
    }
  }

  const merged = [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  // Bounded like every other AI-prompt source in this app
  // (MAX_ENTITIES_PER_MESSAGE, message-history pagination): keep the most
  // recent DIGEST_MAX_TOTAL_MESSAGES if the combined window produced more
  // than that, not an arbitrarily large prompt.
  const capped =
    merged.length > DIGEST_MAX_TOTAL_MESSAGES ? merged.slice(merged.length - DIGEST_MAX_TOTAL_MESSAGES) : merged;

  const messages = capped.map((row) => ({
    channelName: row.channel_name,
    username: row.username,
    content: row.content,
  }));

  return { messages, mentionCount, channelMessageCount: channelRows.length };
}
