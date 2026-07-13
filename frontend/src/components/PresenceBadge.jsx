// Purely reflects server-observed presence passed in via props — never
// derives from a client-side timestamp (PROJECT_PLAN.md Section 6,
// Presence Engine).
const colorFor = {
  online: 'var(--brg)',
  away: 'var(--text-4)',
  offline: 'transparent',
};

// `variant="onMine"` (FEATURE_REQUEST.md's iMessage-style bubble layout
// entry): the "online" dot color is `var(--brg)` — the exact same token a
// "mine" bubble now fills its background with, so a green dot on a
// green-filled bubble is effectively invisible. A thin contrasting ring
// (not a color swap — the dot's own color is still meaningful status
// information, same instinct as the mention/link contrast fix in
// markdown.jsx) keeps it visible regardless of how close the dot and
// background colors happen to be, rather than only patching this one
// specific color collision.
export default function PresenceBadge({ status = 'offline', variant }) {
  if (status === 'offline') return null;
  return (
    <span
      title={status}
      aria-label={`Presence: ${status}`}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colorFor[status] ?? colorFor.offline,
        marginLeft: 6,
        flexShrink: 0,
        ...(variant === 'onMine' ? { boxShadow: '0 0 0 1.5px var(--item-active-fg)' } : {}),
      }}
    />
  );
}
