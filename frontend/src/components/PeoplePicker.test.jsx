import { describe, test, expect } from 'vitest';
import { personSecondaryLabel } from './PeoplePicker.jsx';

// FEATURE_REQUEST.md entry 1: backend/src/routes/workspaces.js's
// members-search no longer returns email, so PeoplePicker's secondary line
// needs a non-blank fallback for callers backed by that endpoint, while
// people-search-backed callers (still email-capable) keep showing it. Only
// this pure helper is unit tested — no jsdom in this project's Vitest setup
// (see ChannelView.test.jsx), so a rendered-component test isn't available.
describe('personSecondaryLabel', () => {
  test('shows the ineligibility reason when one is given, regardless of email', () => {
    expect(personSecondaryLabel({ username: 'alice', email: 'alice@example.com' }, 'Already a member')).toBe(
      'Already a member',
    );
  });

  test('shows email when present (people-search-backed callers)', () => {
    expect(personSecondaryLabel({ username: 'alice', email: 'alice@example.com' }, null)).toBe('alice@example.com');
  });

  test('falls back to @username when email is absent (members-search-backed callers)', () => {
    expect(personSecondaryLabel({ username: 'alice', email: undefined }, null)).toBe('@alice');
  });
});
