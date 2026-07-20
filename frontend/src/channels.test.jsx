import { describe, test, expect } from 'vitest';
import { canSelfJoinChannel } from './channels.js';

// GET /:workspaceId/channels lists PRIVATE channels a system admin isn't a
// member of too (isMember: false) — the "private + not-member" case here
// pins the exact bug this predicate fixes: a "Join" pill that used to render
// for a channel the self-join endpoint always 400s on.
describe('canSelfJoinChannel', () => {
  test('a PUBLIC channel the caller is not a member of is joinable', () => {
    expect(canSelfJoinChannel({ type: 'PUBLIC', isMember: false })).toBe(true);
  });

  test('a PUBLIC channel the caller already belongs to is not offered again', () => {
    expect(canSelfJoinChannel({ type: 'PUBLIC', isMember: true })).toBe(false);
  });

  test('a PRIVATE channel the caller is not a member of is never self-joinable', () => {
    expect(canSelfJoinChannel({ type: 'PRIVATE', isMember: false })).toBe(false);
  });

  test('a PRIVATE channel the caller already belongs to is not offered either', () => {
    expect(canSelfJoinChannel({ type: 'PRIVATE', isMember: true })).toBe(false);
  });
});
