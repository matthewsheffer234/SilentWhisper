// Purely reflects server-observed presence passed in via props — never
// derives from a client-side timestamp (PROJECT_PLAN.md Section 6,
// Presence Engine).
const colorFor = {
  online: 'var(--brg)',
  away: 'var(--text-4)',
  offline: 'transparent',
};

export default function PresenceBadge({ status = 'offline' }) {
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
      }}
    />
  );
}
