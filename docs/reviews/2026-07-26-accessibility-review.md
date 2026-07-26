# 2026-07-26 Accessibility / UI Robustness Review

Prompt: `docs/code-review-prompts.md` -> Accessibility & UI Robustness Review.

Scope reviewed from current source: shared UI primitives, navigation/sidebar rows, menus, sheets/dialogs, message composers, markdown/task rendering, focus/reduced-motion CSS, and E2E coverage.

## Findings

### Low: known dark-mode contrast debt remains unresolved

The README still lists contrast debt for shared design tokens (`README.md:33-38`). Current tokens include dark-mode secondary/tertiary text values and active row colors in `frontend/src/global.css:119-127`. I did not find a current source change that resolves or re-measures those token pairs.

This is not a hidden regression; it is a documented known issue. Resolve by adjusting the shared token values or adding a token-level contrast test so future changes do not reintroduce sub-AA combinations.

## Verified Controls

- The app includes a keyboard-reachable skip link, consistent focus-visible rings, and reduced-motion handling (`frontend/src/global.css:227-277`).
- Shared `Sheet` dialogs use `role="dialog"`, `aria-modal`, initial focus, Escape handling, backdrop close, dirty-state confirmation, and focus return (`frontend/src/components/Sheet.jsx:55-146`).
- Sheet behavior has E2E coverage for Escape/focus return, backdrop close, dirty confirmation, and Tab trapping (`frontend/e2e/workflows.spec.js:2288-2434`).
- Shared `Menu` uses menu roles, active-descendant highlighting, keyboard navigation, Escape handling, checked states, disabled states, and 44px minimum item height.
- Message composers are textareas with autocomplete/listbox ARIA, and current E2E coverage exercises multi-line composer behavior.
- Inline task checkboxes render as real checkbox controls with stable 44px targets.
- Icon-only buttons reviewed in the core shell/sidebar/channel/thread surfaces carry `aria-label` values.
