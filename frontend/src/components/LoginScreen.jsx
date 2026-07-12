import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

const styles = {
  outer: {
    display: 'flex',
    minHeight: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--surface)',
    fontFamily: 'var(--font-sans)',
  },
  card: {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    boxShadow: 'var(--card-shadow)',
    borderRadius: 16,
    padding: '36px 40px',
    width: 360,
    maxWidth: '92vw',
  },
  title: { fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--brg)', margin: '0 0 4px' },
  subtitle: { fontSize: 'var(--text-sm)', color: 'var(--text-3)', margin: '0 0 24px' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  label: { fontSize: 'var(--text-xs)', color: 'var(--text-2)', fontWeight: 600 },
  input: {
    fontSize: 'var(--text-base)',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    boxShadow: 'var(--input-shadow)',
    minHeight: 44,
  },
  button: {
    width: '100%',
    minHeight: 44,
    marginTop: 8,
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontSize: 'var(--text-base)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  toggle: {
    marginTop: 18,
    fontSize: 'var(--text-sm)',
    color: 'var(--text-3)',
    textAlign: 'center',
  },
  toggleLink: { color: 'var(--brg)', cursor: 'pointer', fontWeight: 600, background: 'none', border: 'none', font: 'inherit' },
  error: {
    background: 'var(--error-bg)',
    border: '1px solid var(--error-border)',
    color: 'var(--error-text)',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 'var(--text-sm)',
    marginBottom: 16,
  },
};

export default function LoginScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login({ username, password });
      } else {
        await signup({ username, email, password });
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.outer}>
      <div className="sl-card" style={styles.card}>
        <h1 style={styles.title}>Silent Whisper</h1>
        <p style={styles.subtitle}>{mode === 'login' ? 'Sign in to your workspace' : 'Create an account'}</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="username">Username</label>
            <input
              id="username"
              style={styles.input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>

          {mode === 'signup' && (
            <div style={styles.field}>
              <label style={styles.label} htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                style={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
          )}

          <div style={styles.field}>
            <label style={styles.label} htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              style={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </div>

          <button type="submit" style={styles.button} disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <div style={styles.toggle}>
          {mode === 'login' ? (
            <>
              Don&apos;t have an account?{' '}
              <button type="button" style={styles.toggleLink} onClick={() => setMode('signup')}>Sign up</button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" style={styles.toggleLink} onClick={() => setMode('login')}>Sign in</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
