import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// FEATURE_REQUEST.md's "standard modal/sheet component" entry: every modal
// panel in this app (AiSettingsPanel, AuditDashboard, ChangePasswordPanel,
// UserManagementPanel, BrowseWorkspacesPanel, CreateOrganizationModal,
// OrgManagementPanel, SystemAdminPanel) had independently hand-copied the
// same backdrop/panel/header/title/close-button shell — several of their own
// comments say as much ("same modal shape as AiSettingsPanel/AuditDashboard").
// This is that shell, extracted once: backdrop, panel, title, subtitle,
// close button, focus trap, Escape-to-close, return-focus-on-close, and
// optional dirty-form protection on backdrop click / Escape. `width` and
// `maxHeight` stay per-caller props rather than baked in — each panel's size
// is tuned to its own content (a table-heavy admin panel needs more room
// than a two-field password form), and standardizing those away would be a
// real, unwanted visual regression, not just cleanup.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  panel: {
    maxWidth: '94vw',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface)',
    borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
    padding: '20px 24px',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-1)' },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
  },
  subtitle: { fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 12 },
};

export default function Sheet({ ariaLabel, title, subtitle, onClose, width = 480, maxHeight, isDirty = false, children }) {
  const panelRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  // Initial focus + return-focus-to-trigger, run once per mount (this
  // component is always conditionally rendered by its caller, so mount ===
  // "opened" and unmount === "closed" — no separate `open` prop needed).
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    const firstFocusable = panelRef.current?.querySelector(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panelRef.current)?.focus();

    return () => {
      // The element that opened this sheet may itself have been removed
      // from the DOM by the time this runs (e.g. a row action that
      // disappears after the row it belonged to changes) — focus() on a
      // detached/gone element is a silent no-op, not an error, so no extra
      // guard is needed beyond the optional-chaining call itself.
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  function requestClose() {
    // eslint-disable-next-line no-alert
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }

  useEffect(() => {
    function handleKeyDown(e) {
      // ConfirmDialog.jsx (and any other Sheet opened from within an
      // already-open one, e.g. Reset Password launched from inside Manage
      // Users) isn't portaled — it mounts as a DOM descendant of the outer
      // Sheet, so both panels' keydown listeners are simultaneously live on
      // `document`. Without this guard, Escape on the inner dialog would
      // also fire the outer panel's own handler and close it too. Since
      // each Sheet moves focus into itself on mount and traps it there,
      // "is activeElement inside my own panel" is exactly "am I the
      // topmost/focused one" — the only Sheet that should react.
      if (!panelRef.current?.contains(document.activeElement)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: Tab/Shift+Tab cycles within the panel only, never back
      // out to the page behind the backdrop.
      const focusables = panelRef.current?.querySelectorAll(FOCUSABLE_SELECTOR);
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  return (
    <div style={styles.backdrop} onClick={requestClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        style={{
          ...styles.panel,
          width,
          ...(maxHeight ? { maxHeight, overflowY: 'auto' } : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <span style={styles.title}>{title}</span>
          <button type="button" style={styles.closeButton} onClick={requestClose} aria-label={`Close ${ariaLabel ?? title}`}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {subtitle && <div style={styles.subtitle}>{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}
