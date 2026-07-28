import { describe, test, expect } from 'vitest';
import { clampWidth, resolveSidebarWidth } from './sidebarResize.js';

describe('clampWidth', () => {
  test('passes through a value already within bounds', () => {
    expect(clampWidth(300, 220, 420)).toBe(300);
  });

  test('clamps a value below the minimum up to the minimum', () => {
    expect(clampWidth(100, 220, 420)).toBe(220);
  });

  test('clamps a value above the maximum down to the maximum', () => {
    expect(clampWidth(999, 220, 420)).toBe(420);
  });

  test('a value exactly on a bound is left unchanged', () => {
    expect(clampWidth(220, 220, 420)).toBe(220);
    expect(clampWidth(420, 220, 420)).toBe(420);
  });
});

describe('resolveSidebarWidth', () => {
  const bounds = { min: 220, max: 420, fallback: 260 };

  test('parses a valid persisted width', () => {
    expect(resolveSidebarWidth('300', bounds)).toBe(300);
  });

  test('falls back to the default when nothing was ever persisted (localStorage returns null)', () => {
    expect(resolveSidebarWidth(null, bounds)).toBe(260);
  });

  test('falls back to the default for a non-numeric stored value', () => {
    expect(resolveSidebarWidth('not-a-number', bounds)).toBe(260);
  });

  test('falls back to the default for an empty string', () => {
    expect(resolveSidebarWidth('', bounds)).toBe(260);
  });

  test('clamps an out-of-range persisted value rather than trusting it verbatim', () => {
    expect(resolveSidebarWidth('9999', bounds)).toBe(420);
    expect(resolveSidebarWidth('1', bounds)).toBe(220);
  });

  test('accepts a numeric value carried over from before a bounds change, clamped to the current bounds', () => {
    // Simulates a width persisted under a previous, wider min/max.
    expect(resolveSidebarWidth('150', bounds)).toBe(220);
  });
});
