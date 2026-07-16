// FEATURE_REQUEST.md entry 3 (Direct Messages navigation): "Rows should
// show display names for one-to-one DMs and member names for group DMs."
// Shared by WorkspaceSidebar.jsx's row label and ChatShell.jsx's
// ChannelView-shape conversion so the two surfaces never disagree on what a
// given DM/group-DM is called.
export function directMessageLabel(dm) {
  const names = dm.members.map((m) => m.displayName || m.username);
  return names.length > 0 ? names.join(', ') : 'Direct Message';
}
