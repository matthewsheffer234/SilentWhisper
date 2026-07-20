import { describe, test, expect } from 'vitest';
import { shouldShowDigestTrigger } from './WorkspaceSidebar.jsx';

// FEATURE_REQUEST.md entry 2 (2026-07-20 backlog): "Catch Me Up" relocated
// from a standalone WorkspaceHome.jsx row into an icon-only sidebar trigger
// on the workspace row. shouldShowDigestTrigger is the pure predicate
// deciding whether that trigger renders — unit-tested directly here, same
// "no jsdom in this frontend's Vitest setup" reasoning ChannelView.test.jsx
// already documents for its own pure-helper tests.
describe('shouldShowDigestTrigger', () => {
  test('shows for the currently selected workspace when it has channels', () => {
    expect(shouldShowDigestTrigger('ws-1', 'ws-1', 3)).toBe(true);
  });

  test('does not show for a workspace row that is not the currently selected one', () => {
    expect(shouldShowDigestTrigger('ws-2', 'ws-1', 3)).toBe(false);
  });

  test('does not show for the selected workspace before it has any channels', () => {
    expect(shouldShowDigestTrigger('ws-1', 'ws-1', 0)).toBe(false);
  });

  test('no selected workspace at all means no row ever matches', () => {
    expect(shouldShowDigestTrigger('ws-1', null, 3)).toBe(false);
  });

  // Read-only, so shown regardless of archived state — unlike the settings
  // overflow trigger, generating a digest doesn't require write access.
  // There's no archived-state parameter at all: this pins that the
  // predicate has no hidden "unless archived" branch that could silently
  // start hiding it, since both the active- and archived-workspace row
  // blocks in WorkspaceSidebar.jsx call this identically.
  test('has no archived-state parameter to accidentally gate on', () => {
    expect(shouldShowDigestTrigger.length).toBe(3);
  });
});
