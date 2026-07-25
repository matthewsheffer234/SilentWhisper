import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

// FEATURE_REQUEST.md's Apple HIG UI/UX overhaul entry: a reusable pull-down-
// button-style menu (Apple's actual term for "a button that reveals a menu
// of items related to the button's purpose") — this app had zero
// menu/popover primitives before this entry, so every past feature that
// needed "one more entry point" just added one more flat button or one more
// full-screen modal. Portal-rendered into document.body (not positioned
// relative to an in-flow ancestor) because several triggers using this
// (per-workspace overflow menus) live inside WorkspaceSidebar's
// `overflowY: 'auto'` scrollable section — a popover positioned relative to
// that ancestor would get clipped the moment it needed to render outside
// the scrolled viewport.
//
// Pure keyboard-navigation math, exported so it's unit-testable in
// isolation — this project's Vitest setup has no jsdom (see
// PeoplePicker.test.jsx's own note), so a rendered <Menu> can't be driven
// through real keydown events; this is the same "extract the pure logic"
// workaround already established there. Returns the next highlightedIndex
// for ArrowDown/ArrowUp (wrapping, skipping disabled items) or Home/End
// (jumping to the first/last enabled item); any other key is a no-op that
// returns highlightedIndex unchanged.
export function nextHighlightedIndex(items, highlightedIndex, key) {
  const enabledIndices = [];
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].disabled) enabledIndices.push(i);
  }
  if (enabledIndices.length === 0) return highlightedIndex;

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const currentPos = enabledIndices.indexOf(highlightedIndex);
    const delta = key === 'ArrowDown' ? 1 : -1;
    const nextPos = currentPos === -1 ? 0 : (currentPos + delta + enabledIndices.length) % enabledIndices.length;
    return enabledIndices[nextPos];
  }
  if (key === 'Home') return enabledIndices[0];
  if (key === 'End') return enabledIndices[enabledIndices.length - 1];
  return highlightedIndex;
}

// items: [{ key, label, onSelect, checked?, disabled?, separatorBefore? }]
export default function Menu({ ariaLabel, renderTrigger, items }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  // ariaLabel (e.g. "Thread AI actions") isn't id-safe — whitespace isn't
  // allowed in an HTML id — so item ids are built from useId()'s own
  // collision-free token instead, not a slugified ariaLabel.
  const baseId = useId();

  function openMenu() {
    const rect = triggerRef.current.getBoundingClientRect();
    const top = rect.bottom + 4;
    setPosition({
      top,
      left: Math.min(rect.left, window.innerWidth - 220),
      // A long item list (many workspaces/organizations) can render taller
      // than the remaining viewport below the trigger — `top` varies per
      // trigger position, so this is computed here rather than as a static
      // CSS value, with its own scroll container picking up the overflow
      // instead of the menu silently extending past the bottom of the
      // screen with no way to reach it.
      maxHeight: Math.max(120, window.innerHeight - top - 12),
    });
    setHighlightedIndex(-1);
    setOpen(true);
  }

  function closeMenu({ returnFocus = true } = {}) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.focus();

    function handlePointerDown(e) {
      if (menuRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      closeMenu({ returnFocus: false });
    }
    // Resize (rare, and never happens mid-click) closes the menu — a
    // deliberate viewport change makes a fixed-position popover's captured
    // coordinates stale. Scroll deliberately does NOT close it: a capture-
    // phase window 'scroll' listener catches every scroll bubbling from any
    // ancestor, including one an interaction can trigger incidentally (e.g.
    // a browser scrolling a partially-visible menu item into view as part
    // of clicking it) — a real bug caught by testing, not a hypothetical:
    // the menu closed itself mid-click, detaching the very item being
    // clicked from the DOM. This app's menus are short-lived, low-frequency
    // surfaces; a stale position after a genuine background scroll is a far
    // smaller cost than closing out from under an in-progress selection.
    function handleResize() {
      closeMenu({ returnFocus: false });
    }
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [open]);

  function activate(item) {
    if (item.disabled) return;
    closeMenu();
    item.onSelect();
  }

  function handleMenuKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      closeMenu({ returnFocus: false });
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHighlightedIndex(nextHighlightedIndex(items, highlightedIndex, e.key));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (highlightedIndex !== -1) activate(items[highlightedIndex]);
    }
  }

  const styles = {
    menu: {
      position: 'fixed',
      top: position?.top ?? 0,
      left: position?.left ?? 0,
      minWidth: 180,
      maxWidth: 260,
      // No cap previously — fine for a handful of items, but a long list
      // (many workspaces/organizations) rendered past the bottom of the
      // viewport with no way to reach it, since a `position: fixed` element
      // doesn't scroll with the page. openMenu() computes this relative to
      // where the menu actually starts (`top`), not a flat viewport
      // fraction, since `top` varies per trigger position.
      maxHeight: position?.maxHeight,
      overflowY: 'auto',
      background: 'var(--overlay-bg)',
      boxShadow: 'var(--overlay-shadow)',
      border: '1px solid var(--border)',
      borderRadius: 11,
      padding: '6px 0',
      zIndex: 80,
    },
    separator: { height: 1, background: 'var(--border)', margin: '6px 0' },
    item: (highlighted, disabled) => ({
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minHeight: 44,
      padding: '0 14px',
      fontSize: 'var(--text-sm)',
      color: disabled ? 'var(--text-4)' : 'var(--text-1)',
      background: highlighted ? 'var(--item-hover)' : 'transparent',
      cursor: disabled ? 'default' : 'pointer',
    }),
    checkGlyph: { width: 14, display: 'inline-flex', alignItems: 'center', color: 'var(--brg)' },
  };

  return (
    <>
      {renderTrigger({
        ref: triggerRef,
        onClick: () => (open ? closeMenu() : openMenu()),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      {open &&
        createPortal(
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <div
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={styles.menu}
            onKeyDown={handleMenuKeyDown}
            aria-activedescendant={highlightedIndex !== -1 ? `${baseId}-item-${highlightedIndex}` : undefined}
          >
            {items.map((item, index) => (
              <div key={item.key}>
                {item.separatorBefore && <div style={styles.separator} role="separator" />}
                <div
                  id={`${baseId}-item-${index}`}
                  role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={item.checked !== undefined ? item.checked : undefined}
                  aria-disabled={item.disabled || undefined}
                  style={styles.item(index === highlightedIndex, item.disabled)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => activate(item)}
                >
                  {item.checked !== undefined && (
                    <span style={styles.checkGlyph}>{item.checked && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}</span>
                  )}
                  {item.label}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
