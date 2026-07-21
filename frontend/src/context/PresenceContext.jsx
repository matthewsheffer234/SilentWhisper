import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import PresenceBadge from '../components/PresenceBadge.jsx';

// Finding 7, docs/reviews/security-performance-review-2026-07-20.md: presence
// used to be plain ChatShell.jsx state (`presence`/`setPresence`), threaded
// as a `presence` prop into WorkspaceSidebar/ChannelView/ThreadSidebar/
// ChannelDetailsPanel. Every presence transition (bursty during a login
// rush or mass-reconnect — see ws/presence.js) replaced that whole object,
// which re-rendered ChatShell itself and, by prop-passing, every one of
// those components — for ChannelView/ThreadSidebar, their entire currently
// visible message list — even though only a handful of presence badges
// actually needed to change.
//
// Presence now lives in its own context, decoupled from ChatShell's render
// cycle entirely: ChatShell's WS handlers call the stable mergePresence()/
// setUserPresence() functions below (via usePresenceUpdater), but nothing
// in ChatShell itself ever reads the `presence` value, so a presence tick
// no longer re-renders ChatShell — or, by extension, any memoized
// descendant that isn't itself a presence consumer. Only UserPresenceBadge
// below actually subscribes to the value.
const PresenceContext = createContext(null);

export function PresenceProvider({ children }) {
  const [presence, setPresence] = useState({});

  const mergePresence = useCallback((patch) => {
    setPresence((prev) => ({ ...prev, ...patch }));
  }, []);

  const setUserPresence = useCallback((userId, status) => {
    setPresence((prev) => ({ ...prev, [userId]: status }));
  }, []);

  const value = useMemo(
    () => ({ presence, mergePresence, setUserPresence }),
    [presence, mergePresence, setUserPresence],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

function usePresenceContext() {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error('usePresenceContext must be used within PresenceProvider');
  return ctx;
}

// ChatShell's WS handlers ('authenticated'/'presence_update' frames) call
// this — mergePresence/setUserPresence are stable (useCallback, empty deps)
// across the presence value itself changing, so a component that only ever
// calls this hook (never reads .presence) doesn't re-render on a presence
// tick either.
export function usePresenceUpdater() {
  const { mergePresence, setUserPresence } = usePresenceContext();
  return { mergePresence, setUserPresence };
}

// The one thing that actually re-renders on a presence tick — used
// everywhere a presence dot is shown (message rows, the sidebar's own user
// row, the channel roster) in place of a directly-imported <PresenceBadge>.
// `fallback` mirrors each call site's own prior default (e.g.
// WorkspaceSidebar's own row assumes 'online' for the current user, every
// other call site assumes 'offline' for someone whose status hasn't
// arrived yet).
export function UserPresenceBadge({ userId, variant, fallback = 'offline' }) {
  const { presence } = usePresenceContext();
  return <PresenceBadge status={presence[userId] ?? fallback} variant={variant} />;
}
