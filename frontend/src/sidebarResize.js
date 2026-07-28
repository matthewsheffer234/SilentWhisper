// Pure width-clamping/parsing helpers for the resizable workspace and
// thread sidebars (FEATURE_REQUEST.md's "resizable and collapsible
// sidebars" entry). Same DOM-free split ThemeContext.jsx's own
// resolveTheme/applyTheme already establishes: parsing and clamping a raw
// stored value is pure and unit-tested here (this project's Vitest setup
// has no jsdom — see EntityDetailsPanel.test.jsx's own note); the actual
// `localStorage` read/write happens at the call site in ChatShell.jsx,
// untested for the same reason applyTheme's own comment gives.

export const WORKSPACE_SIDEBAR_WIDTH_KEY = 'sw-workspace-sidebar-width';
export const THREAD_SIDEBAR_WIDTH_KEY = 'sw-thread-sidebar-width';

export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH = 260;
export const WORKSPACE_SIDEBAR_MIN_WIDTH = 220;
export const WORKSPACE_SIDEBAR_MAX_WIDTH = 420;

export const THREAD_SIDEBAR_DEFAULT_WIDTH = 320;
export const THREAD_SIDEBAR_MIN_WIDTH = 280;
export const THREAD_SIDEBAR_MAX_WIDTH = 520;

export function clampWidth(width, min, max) {
  return Math.min(max, Math.max(min, width));
}

// `rawValue` is whatever `localStorage.getItem()` returned — a string, or
// `null` if nothing was ever persisted. Never trusted to already be a
// valid, in-range number: it could be missing, hand-edited, or persisted
// under a previous version's bounds (this entry's own min/max could change
// later), so an out-of-range value is clamped rather than used verbatim.
export function resolveSidebarWidth(rawValue, { min, max, fallback }) {
  const parsed = Number(rawValue);
  if (rawValue === null || rawValue === undefined || rawValue === '' || !Number.isFinite(parsed)) {
    return fallback;
  }
  return clampWidth(parsed, min, max);
}
