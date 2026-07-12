import { useEffect, useState } from 'react';

// Phase 1 placeholder only — the real 3-column workspace/channel/thread
// layout is built in Phase 3 (PROJECT_PLAN.md Section 8). This screen exists
// to prove the frontend can reach the backend end-to-end (design tokens,
// CORS, health check) before auth, WebSockets, or messaging exist.
const backendOrigin = (import.meta.env.VITE_API_URL || 'http://localhost:8000/api').replace(/\/api\/?$/, '');

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-sans)',
  },
  card: {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    boxShadow: 'var(--card-shadow)',
    borderRadius: 16,
    padding: '32px 40px',
    maxWidth: 480,
    color: 'var(--text-1)',
  },
  title: {
    fontSize: 'var(--text-xl)',
    fontWeight: 700,
    margin: '0 0 8px',
    color: 'var(--brg)',
  },
  subtitle: {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-3)',
    margin: '0 0 20px',
  },
  status: {
    fontSize: 'var(--text-base)',
    fontWeight: 600,
  },
  ok: { color: 'var(--success-text)' },
  error: { color: 'var(--error-text)' },
};

export default function App() {
  const [health, setHealth] = useState({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`${backendOrigin}/health`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!cancelled) setHealth({ state: ok ? 'ok' : 'error', body });
      })
      .catch((err) => {
        if (!cancelled) setHealth({ state: 'error', body: { message: err.message } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main id="main" style={styles.page}>
      <div className="sl-card" style={styles.card}>
        <h1 style={styles.title}>Silent Whisper</h1>
        <p style={styles.subtitle}>Phase 1: foundation &amp; database setup</p>
        {health.state === 'loading' && <p style={styles.status}>Checking backend…</p>}
        {health.state === 'ok' && (
          <p style={{ ...styles.status, ...styles.ok }}>
            Backend reachable — DB: {health.body.db}, uptime {health.body.uptimeSeconds}s
          </p>
        )}
        {health.state === 'error' && (
          <p style={{ ...styles.status, ...styles.error }}>
            Backend unreachable: {health.body?.message || 'unknown error'}
          </p>
        )}
      </div>
    </main>
  );
}
