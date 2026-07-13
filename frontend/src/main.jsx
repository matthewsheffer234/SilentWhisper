import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ThemeProvider, resolveTheme, applyTheme, THEME_STORAGE_KEY } from './context/ThemeContext.jsx';
import './global.css';

// Applied synchronously, before the app renders, to minimize a
// flash-of-wrong-theme for a returning user with a saved Light/Dark
// preference. Not an inline <script> in index.html (the more typical fix
// for this) because the CSP's scriptSrc is 'self'-only with no
// 'unsafe-inline' (backend/src/middleware/security.js, PROJECT_PLAN.md
// Section 3) — this is the earliest an external, CSP-compliant module can
// act. ThemeProvider re-applies the same value on mount regardless, so
// this is a best-effort head start, not the only place this happens.
applyTheme(resolveTheme(localStorage.getItem(THEME_STORAGE_KEY)));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AuthProvider>
  </React.StrictMode>,
);
