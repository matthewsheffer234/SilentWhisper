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

  const signup = useCallback(async (details) => {
    const newUser = await authApi.signup(details);
    setUser(newUser);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(() => ({ user, status, login, signup, logout }), [user, status, login, signup, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
