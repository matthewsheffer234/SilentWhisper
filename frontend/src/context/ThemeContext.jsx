import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// System/Light/Dark appearance toggle (FEATURE_REQUEST.md). global.css
// already defines the full light/dark token set plus a
// `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
// layer (PROJECT_PLAN.md Section 7) — this is the only piece that was
// missing: something that actually sets/clears the `data-theme` attribute,
// plus a place to persist the user's explicit choice.
//
// Own localStorage key ('sw-theme'), distinct from Silent Lattice's own
// 'sl-theme' — the two apps' preferences aren't meant to be coupled just
// because they share a domain suffix. A plain three-value string, not a
// credential, so localStorage is fine here (PROJECT_PLAN.md Section 3's
// access-token-storage rule only concerns auth tokens).
export const THEME_STORAGE_KEY = 'sw-theme';
const VALID_THEMES = ['system', 'light', 'dark'];

// Pure and DOM-free on purpose (no `document`/`localStorage` reads inside),
// so it's unit-testable without a jsdom-style environment — this frontend's
// existing Vitest setup (see markdown.test.jsx) deliberately has none, and
// this follows the same "keep the pure logic separately testable from the
// DOM side effects" split rather than adding a new test-environment
// dependency for one small function.
export function resolveTheme(rawValue) {
  return VALID_THEMES.includes(rawValue) ? rawValue : 'system';
}

// The DOM side effect half of resolveTheme's decision — applied from
// main.jsx (before first paint, best-effort) and from this context
// (on mount and on every change). Not unit tested for the same reason
// resolveTheme is kept separate from it: no DOM in this test environment;
// covered by the e2e suite instead, which runs in a real browser.
export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => resolveTheme(localStorage.getItem(THEME_STORAGE_KEY)));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next) => {
    const resolved = resolveTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
    setThemeState(resolved);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
