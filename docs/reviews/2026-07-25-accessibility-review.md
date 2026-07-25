# Accessibility & HIG Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
Accessibility posture: **Mostly compliant with several low/medium UI-control gaps**. The frontend has strong foundations: global focus-visible styles, skip-link support, accessible modal dialogs with focus trapping, keyboard-activatable custom rows, live regions for mention toasts, and reduced-motion handling. README already tracks the known `--text-3` / dark active-row contrast shortfall, so it is noted here as existing known debt rather than a new discovery.

The most important new issue is menu semantics: the menu container receives focus and supports arrow keys, but individual menu items are not focusable and the active item is not exposed with `aria-activedescendant`. Several compact controls also fall below Apple HIG's 44px target.

---

## Findings Matrix

| Severity | Domain | Finding / Violation | Location |
|---|---|---|---|
| Medium | Screen Reader / Menu Semantics | Menu highlight state is visual-only and not exposed via focus or `aria-activedescendant` | `frontend/src/components/Menu.jsx:164` |
| Low | Touch Targets | Some compact action controls are below 44px HIG minimum | `frontend/src/components/EntityDetailsPanel.jsx:175` |
| Info | Contrast | Known `--text-3` and dark active-row contrast issue remains documented | `README.md:37` |

---

## Detailed Findings & Remediations

### [A11Y-01] Menu Active Item Is Not Programmatically Exposed
- **Severity**: Medium
- **Domain**: Screen Reader / Menu Semantics
- **Location**: `frontend/src/components/Menu.jsx:L164-L181`
- **Violation & User Impact**: `Menu` focuses the menu container and tracks `highlightedIndex` internally. Visual highlighting changes on arrow keys, but the focused element remains the menu container and no `aria-activedescendant` points to the highlighted item. Screen reader users may not hear which item is currently active.
- **Recommended Remediation**:
  ```jsx
  <div
    role="menu"
    tabIndex={-1}
    aria-activedescendant={highlightedIndex >= 0 ? `${ariaLabel}-item-${highlightedIndex}` : undefined}
  >
    {items.map((item, index) => (
      <div id={`${ariaLabel}-item-${index}`} role="menuitem">
        {item.label}
      </div>
    ))}
  </div>
  ```

### [A11Y-02] Compact Controls Miss 44px Touch Targets
- **Severity**: Low
- **Domain**: Touch Targets
- **Location**: `frontend/src/components/EntityDetailsPanel.jsx:L175-L176`, `frontend/src/components/Menu.jsx:L139-L145`
- **Violation & User Impact**: Some removable chips/buttons are 18-26px and menu items are 40px tall. They are usable with a mouse, but miss Apple HIG's 44x44pt target and are harder for touch and motor-impaired users.
- **Recommended Remediation**:
  ```js
  removeButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
  ```

### [A11Y-03] Known Contrast Debt Remains
- **Severity**: Informational
- **Domain**: Theme Contrast
- **Location**: `README.md:L37-L37`, `frontend/src/global.css:L54-L57`
- **Violation & User Impact**: README already documents that `--text-3` and dark active-row contrast are below WCAG AA for their font sizes. This is not a new finding, but it remains active debt for secondary labels, timestamps, and metadata.
- **Recommended Remediation**:
  ```css
  :root {
    --text-3: #5f6b64;
  }
  [data-theme='dark'] {
    --text-3: #82988c;
  }
  ```

## Architectural Wins & Verified HIG Patterns
- `Sheet.jsx` implements `role="dialog"`, `aria-modal`, Escape close, focus trap, and focus return.
- Row-like navigation controls handle Enter and Space.
- Global `:focus-visible` styles cover buttons and `[role="button"]`.
- Mention toasts use `role="status"` and `aria-live="polite"`.
- `prefers-reduced-motion` is respected in global CSS.
