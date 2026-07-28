import { useEffect, useRef, useState } from 'react';
import { clampWidth } from '../sidebarResize.js';

// Shared drag/keyboard-resize handle for the workspace and thread sidebars
// (FEATURE_REQUEST.md's "resizable and collapsible sidebars" entry). A
// plain `pointerdown`/`pointermove`/`pointerup` drag — no drag library —
// since the interaction is one axis, one element, matching this app's
// existing convention of hand-rolling small, single-purpose interactions
// (e.g. Menu.jsx's own outside-click/positioning logic) rather than adding
// a dependency for something this narrow.
const HIT_WIDTH = 6;

const styles = {
  hitArea: {
    width: HIT_WIDTH,
    flexShrink: 0,
    cursor: 'col-resize',
    display: 'flex',
    justifyContent: 'center',
    touchAction: 'none',
  },
  line: {
    width: 1,
    alignSelf: 'stretch',
  },
};

// `invert` flips which drag/arrow direction grows the panel: the workspace
// sidebar's splitter sits on that sidebar's *right* edge (dragging right
// grows it, invert=false), while the thread sidebar's splitter sits on
// *its* left edge (dragging left grows it, invert=true) — same width, same
// component, opposite geometry.
export default function Splitter({ ariaLabel, value, min, max, step = 16, invert = false, onChange }) {
  const dragStateRef = useRef(null); // { startX, startValue } | null
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!dragging) return undefined;

    function handlePointerMove(e) {
      if (!dragStateRef.current) return;
      const rawDelta = e.clientX - dragStateRef.current.startX;
      const signedDelta = invert ? -rawDelta : rawDelta;
      onChange(clampWidth(dragStateRef.current.startValue + signedDelta, min, max));
    }
    function handlePointerUp() {
      dragStateRef.current = null;
      setDragging(false);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragging, invert, min, max, onChange]);

  function handlePointerDown(e) {
    // Only the primary button/touch point starts a drag — a right-click or
    // secondary pointer shouldn't hijack the resize.
    if (e.button !== undefined && e.button !== 0) return;
    dragStateRef.current = { startX: e.clientX, startValue: value };
    setDragging(true);
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(clampWidth(value + (invert ? step : -step), min, max));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(clampWidth(value + (invert ? -step : step), min, max));
    }
  }

  const lineActive = dragging || hovered;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      style={styles.hitArea}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ ...styles.line, background: lineActive ? 'var(--border-strong)' : 'var(--border)' }} />
    </div>
  );
}
