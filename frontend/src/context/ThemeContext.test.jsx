import { describe, test, expect } from 'vitest';
import { resolveTheme } from './ThemeContext.jsx';

// FEATURE_REQUEST.md's Light/Dark appearance toggle entry. Only
// resolveTheme is unit tested here — it's pure and DOM-free by design
// (see its own comment in ThemeContext.jsx). applyTheme/ThemeProvider
// touch `document`/`localStorage`, and this frontend's Vitest setup has
// no jsdom-style environment (same reason markdown.test.jsx inspects
// React elements directly instead of rendering to a DOM) — that side is
// covered by the e2e suite's real browser instead.

describe('resolveTheme', () => {
  test('defaults to system when given undefined (no stored value)', () => {
    expect(resolveTheme(undefined)).toBe('system');
  });

  test('defaults to system when given null (localStorage.getItem miss)', () => {
    expect(resolveTheme(null)).toBe('system');
  });

  test('falls back to system for an invalid/corrupt stored value', () => {
    expect(resolveTheme('blue')).toBe('system');
  });

  test('passes through a valid light value', () => {
    expect(resolveTheme('light')).toBe('light');
  });

  test('passes through a valid dark value', () => {
    expect(resolveTheme('dark')).toBe('dark');
  });

  test('passes through an explicit system value', () => {
    expect(resolveTheme('system')).toBe('system');
  });
});
