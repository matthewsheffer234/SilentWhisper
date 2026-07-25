import { describe, test, expect } from 'vitest';
import { nextHighlightedIndex } from './Menu.jsx';

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #11 (MAINT-02):
// Menu's keyboard/highlight behavior had no focused tests. Only this pure
// helper is unit tested — no jsdom in this project's Vitest setup (see
// PeoplePicker.test.jsx/EntityDetailsPanel.test.jsx), so a rendered <Menu>
// driven through real keydown events isn't available; this exercises the
// exact math handleMenuKeyDown delegates to for ArrowDown/ArrowUp/Home/End.
describe('nextHighlightedIndex', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const withDisabled = [{ key: 'a' }, { key: 'b', disabled: true }, { key: 'c' }];

  test('ArrowDown from no selection (-1) selects the first item', () => {
    expect(nextHighlightedIndex(items, -1, 'ArrowDown')).toBe(0);
  });

  test('ArrowUp from no selection (-1) selects the first item, same as ArrowDown', () => {
    expect(nextHighlightedIndex(items, -1, 'ArrowUp')).toBe(0);
  });

  test('ArrowDown advances to the next item', () => {
    expect(nextHighlightedIndex(items, 0, 'ArrowDown')).toBe(1);
  });

  test('ArrowUp moves to the previous item', () => {
    expect(nextHighlightedIndex(items, 1, 'ArrowUp')).toBe(0);
  });

  test('ArrowDown wraps from the last item back to the first', () => {
    expect(nextHighlightedIndex(items, 2, 'ArrowDown')).toBe(0);
  });

  test('ArrowUp wraps from the first item back to the last', () => {
    expect(nextHighlightedIndex(items, 0, 'ArrowUp')).toBe(2);
  });

  test('ArrowDown skips a disabled item in between', () => {
    expect(nextHighlightedIndex(withDisabled, 0, 'ArrowDown')).toBe(2);
  });

  test('ArrowUp skips a disabled item in between', () => {
    expect(nextHighlightedIndex(withDisabled, 2, 'ArrowUp')).toBe(0);
  });

  test('Home jumps to the first enabled item regardless of current position', () => {
    expect(nextHighlightedIndex(items, 2, 'Home')).toBe(0);
  });

  test('End jumps to the last enabled item regardless of current position', () => {
    expect(nextHighlightedIndex(items, 0, 'End')).toBe(2);
  });

  test('Home skips a disabled first item', () => {
    expect(nextHighlightedIndex(withDisabled, 2, 'Home')).toBe(0); // item 0 is the first enabled one already
    expect(nextHighlightedIndex([{ key: 'a', disabled: true }, { key: 'b' }], 1, 'Home')).toBe(1);
  });

  test('an unhandled key returns the current index unchanged', () => {
    expect(nextHighlightedIndex(items, 1, 'PageDown')).toBe(1);
  });

  test('when every item is disabled, every key is a no-op', () => {
    const allDisabled = [{ key: 'a', disabled: true }, { key: 'b', disabled: true }];
    expect(nextHighlightedIndex(allDisabled, -1, 'ArrowDown')).toBe(-1);
    expect(nextHighlightedIndex(allDisabled, -1, 'Home')).toBe(-1);
  });
});
