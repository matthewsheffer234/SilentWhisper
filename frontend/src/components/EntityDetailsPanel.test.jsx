import { describe, test, expect } from 'vitest';
import { smeDisplayName } from './EntityDetailsPanel.jsx';

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Subject Matter Experts).
// Only this pure helper is unit tested — no jsdom in this project's Vitest
// setup (see ChannelView.test.jsx/PeoplePicker.test.jsx), so a rendered
// SmeSection test isn't available.
describe('smeDisplayName', () => {
  test('shows the display name, plus @username, when they differ', () => {
    expect(smeDisplayName({ username: 'alice', displayName: 'Alice Smith' })).toEqual({
      name: 'Alice Smith',
      showUsername: true,
    });
  });

  test('falls back to @username alone when there is no display name', () => {
    expect(smeDisplayName({ username: 'alice', displayName: null })).toEqual({
      name: 'alice',
      showUsername: false,
    });
  });

  test('does not repeat @username when the display name equals the username', () => {
    expect(smeDisplayName({ username: 'alice', displayName: 'alice' })).toEqual({
      name: 'alice',
      showUsername: false,
    });
  });
});
