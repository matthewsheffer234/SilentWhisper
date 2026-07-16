import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as authApi from '../api/auth.js';
import { setOnAuthLost } from '../api/client.js';

const AuthContext = createContext(null);

// status: 'loading' (restoring session on first mount) | 'authenticated' | 'anonymous'
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');
  const restoreAttempted = useRef(false);

  useEffect(() => {
    // React 18 StrictMode double-invokes mount effects in development. Since
    // restoreSession() calls the refresh endpoint, which *rotates* the
    // refresh token on every use, a second concurrent call doesn't just
    // waste a request — it hits reuse detection (Section 3) and 401s. If
    // that duplicate's rejection resolved after the real call's success, it
    // would clobber 'authenticated' back to 'anonymous'. Restoring a session
    // is meant to happen exactly once per app load anyway, so guard it with
    // a ref rather than relying on effect-cleanup timing.
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;

    authApi
      .restoreSession()
      .then((restoredUser) => {
        if (restoredUser) {
          setUser(restoredUser);
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      })
      .catch(() => setStatus('anonymous'));
  }, []);

  useEffect(() => {
    // Any request that fails its silent-refresh retry (client.js) drops the
    // app back to the login screen, regardless of which component triggered it.
    setOnAuthLost(() => {
      setUser(null);
      setStatus('anonymous');
    });
  }, []);

  const login = useCallback(async (credentials) => {
    const loggedInUser = await authApi.login(credentials);
    setUser(loggedInUser);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setStatus('anonymous');
  }, []);

  // Hydrates the context from a session established elsewhere — the invite-
  // redemption flow calls api/invitations.js's acceptInvitation, which
  // already called setAccessToken; this just makes user/status catch up,
  // rather than duplicating signup()'s API call against a different
  // endpoint.
  const completeAuth = useCallback((authenticatedUser) => {
    setUser(authenticatedUser);
    setStatus('authenticated');
  }, []);

  // No user/status change needed on success — same account, still
  // authenticated; authApi.changePassword already swaps in the freshly
  // issued access token (client.js's setAccessToken), the same way
  // login/signup do. A wrong-currentPassword/policy-rejection throw
  // propagates to the caller (ChangePasswordPanel) to show inline, same
  // convention as every other form in this app (see WorkspaceSidebar's
  // InviteMemberForm).
  const changePassword = useCallback(async (credentials) => {
    await authApi.changePassword(credentials);
  }, []);

  // Cosmetic-only self-edit (FEATURE_REQUEST.md's "display names settable in
  // the admin account-creation worksheet" entry) — unlike changePassword, no
  // token rotation happens server-side, so this updates user state directly
  // from the response rather than relying on a side effect in api/auth.js.
  const setDisplayName = useCallback(async (displayName) => {
    const updatedUser = await authApi.updateDisplayName(displayName);
    setUser(updatedUser);
  }, []);

  const value = useMemo(
    () => ({ user, status, login, logout, changePassword, setDisplayName, completeAuth }),
    [user, status, login, logout, changePassword, setDisplayName, completeAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
