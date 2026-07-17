import { describe, test, expect } from 'vitest';
import { isFirstInRun, formatReplyCount, initials } from './ChannelView.jsx';

// FEATURE_REQUEST.md entry 3 (message presentation for team scanability).
// Only these three pure, DOM-free helpers are unit tested here — the
// component itself renders through react-virtual/lucide-react and this
// frontend's Vitest setup has no jsdom-style environment (same reasoning
// ThemeContext.test.jsx documents for resolveTheme()).

describe('isFirstInRun', () => {
  const msg = (id, userId) => ({ id, userId });

  test('the first message in the whole list is always first in its run', () => {
    const messages = [msg('a', 'u1'), msg('b', 'u1')];
    expect(isFirstInRun(messages, 0)).toBe(true);
  });

  test('a message is not first in its run when the previous message shares the sender', () => {
    const messages = [msg('a', 'u1'), msg('b', 'u1')];
    expect(isFirstInRun(messages, 1)).toBe(false);
  });

  test('a message is first in its run when the previous message has a different sender', () => {
    const messages = [msg('a', 'u1'), msg('b', 'u2')];
    expect(isFirstInRun(messages, 1)).toBe(true);
  });

  test('a run resumes correctly after an interruption from a different sender', () => {
    const messages = [msg('a', 'u1'), msg('b', 'u2'), msg('c', 'u1')];
    expect(isFirstInRun(messages, 2)).toBe(true);
  });
});

describe('formatReplyCount', () => {
  test('renders the full "Reply in thread" phrase when there are no replies yet — a bare "Reply" would collide with ThreadSidebar\'s own submit button', () => {
    expect(formatReplyCount(0)).toBe('Reply in thread');
  });

  test('treats undefined the same as zero', () => {
    expect(formatReplyCount(undefined)).toBe('Reply in thread');
  });

  test('uses singular "reply" for exactly one', () => {
    expect(formatReplyCount(1)).toBe('1 reply');
  });

  test('uses plural "replies" for more than one', () => {
    expect(formatReplyCount(3)).toBe('3 replies');
  });
});

describe('initials', () => {
  test('takes the first letter of a first and last name', () => {
    expect(initials('Maria Chen')).toBe('MC');
  });

  test('takes the first two letters of a single-word name', () => {
    expect(initials('mchen')).toBe('MC');
  });

  test('uses first and last of a multi-word name, ignoring the middle', () => {
    expect(initials('Maria Elena Chen')).toBe('MC');
  });

  test('returns an empty string for a missing name', () => {
    expect(initials('')).toBe('');
    expect(initials(undefined)).toBe('');
  });

  test('collapses stray whitespace before splitting', () => {
    expect(initials('  Maria   Chen  ')).toBe('MC');
  });
});
