// Shared by WorkspaceSidebar.jsx and WorkspaceHome.jsx's channel rows so the
// two surfaces never disagree on when a "Join" pill is safe to show.
// GET /:workspaceId/channels lists PRIVATE channels a system admin isn't a
// member of too (structural-visibility override, isMember: false) — the
// self-join endpoint 400s on anything but a PUBLIC channel, so isMember
// alone isn't enough to gate the pill.
export function canSelfJoinChannel(channel) {
  return !channel.isMember && channel.type === 'PUBLIC';
}
