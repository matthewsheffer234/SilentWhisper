import { describe, expect, test } from 'vitest';
import {
  AI_SUMMARY_LIMIT,
  AI_SUMMARY_SCOPE,
  AI_THREAD_SCOPE,
  AI_DIGEST_WINDOW_OPTIONS,
  formatAiActionError,
} from './aiPresentation.js';

describe('AI presentation helpers', () => {
  test('keeps the channel summary scope tied to the request limit', () => {
    expect(AI_SUMMARY_LIMIT).toBe(50);
    expect(AI_SUMMARY_SCOPE).toBe('Last 50 messages');
  });

  test('describes thread task extraction scope plainly', () => {
    expect(AI_THREAD_SCOPE).toBe('This thread');
  });

  test('uses provider/capacity state labels for known AI failures', () => {
    expect(formatAiActionError({ status: 429, message: 'Too many AI requests' }, 'fallback')).toBe(
      'AI service is queued. Please try again shortly.',
    );
    expect(formatAiActionError({ status: 503, message: 'provider down' }, 'fallback')).toBe(
      'AI service is unavailable. Please try again shortly.',
    );
  });

  test('falls back to the server message or caller fallback for ordinary failures', () => {
    expect(formatAiActionError({ status: 400, message: 'No messages to summarize in this channel yet' }, 'fallback')).toBe(
      'No messages to summarize in this channel yet',
    );
    expect(formatAiActionError({}, 'fallback')).toBe('fallback');
  });

  test('reports a cancelled digest request distinctly from a real failure', () => {
    expect(formatAiActionError({ name: 'AbortError' }, 'fallback')).toBe('Cancelled.');
  });

  test('offers a fixed set of plain-language digest window choices', () => {
    expect(AI_DIGEST_WINDOW_OPTIONS).toEqual([
      { sinceHours: 24, label: 'Last 24 hours' },
      { sinceHours: 72, label: 'Last 3 days' },
      { sinceHours: 168, label: 'Last 7 days' },
    ]);
  });
});
