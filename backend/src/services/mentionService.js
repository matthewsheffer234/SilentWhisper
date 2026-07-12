// Sibling to messageService.js, called by both call sites (routes/messages.js's
// REST POST and ws/server.js's handleMessage) *after* createMessage succeeds —
// mention parsing has WebSocket-facing side effects (a targeted `mention`
// frame), so it stays out of createMessage itself, which remains a pure
// DB-insert concern with no WebSocket knowledge (Section 3's anti-drift
// principle, already established for authorization, reused here).

// Matches USERNAME_RE's character class and length bound (validation.js) —
// a mention can only ever resolve to a syntactically-valid username.
const MENTION_RE = /@([a-zA-Z0-9_.-]{3,50})/g;

// Uncapped parsing would let one pasted block of text with hundreds of
// `@word` tokens trigger hundreds of DB lookups and notification pushes per
// message — the same class of resource-bound thinking MAX_MESSAGE_LENGTH
// already applies to message content itself (Section 3).
const MAX_MENTIONS_PER_MESSAGE = 20;

// Resolves against real, existing users who are also members of *this*
// channel. Mentioning a nonexistent username, or a real user who isn't a
// member of the channel the message was posted in, silently resolves to
// nothing — never an error, and never a way to confirm a stranger's
// existence or channel membership by @mentioning a guessed username and
// observing whether *something* happens (Section 3's existence-hiding
// convention, applied to this new surface).
export async function extractMentionedUserIds(db, { content, channelId, excludeUserId }) {
  const seen = new Set();
  for (const match of content.matchAll(MENTION_RE)) {
    seen.add(match[1]);
  }
  if (seen.size === 0) return [];

  const usernames = [...seen].slice(0, MAX_MENTIONS_PER_MESSAGE);

  const rows = await db('channel_members')
    .join('users', 'users.id', 'channel_members.user_id')
    .where('channel_members.channel_id', channelId)
    .whereIn('users.username', usernames)
    .select('users.id');

  return rows.map((r) => r.id).filter((id) => id !== excludeUserId);
}
