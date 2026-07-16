import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../context/AuthContext.jsx';
import * as invitationsApi from '../api/invitations.js';

// Public route (FEATURE_REQUEST.md entry 1, slice 3) — must work whether or
// not a session has already been restored, styled per LoginScreen.jsx's
// card/field/input/button/error pattern rather than reinvented.

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
  context: {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-2)',
    background: 'var(--surface-alt)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 20,
  },
  notice: {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-2)',
    background: 'var(--surface-alt)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 16,
  },
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

export default function InviteRedemptionPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { status, user, completeAuth } = useAuth();
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    invitationsApi
      .previewInvitation(token)
      .then(setPreview)
      .catch(() => setLoadError('This invitation link is invalid or has expired.'));
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const redeemedUser = await invitationsApi.acceptInvitation(token, { username, password });
      completeAuth(redeemedUser);
      navigate('/', { replace: true });
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div id="main" tabIndex={-1} style={styles.outer}>
      <div className="sl-card" style={styles.card}>
        <h1 style={styles.title}>Silent Whisper</h1>
        <p style={styles.subtitle}>You&apos;ve been invited</p>

        {loadError ? (
          <div style={styles.error}>{loadError}</div>
        ) : !preview ? (
          <div style={styles.subtitle}>Loading…</div>
        ) : (
          <>
            <div style={styles.context}>
              <strong>{preview.invitedByDisplayName || preview.invitedByUsername}</strong> invited you to join{' '}
              <strong>{preview.scopeName}</strong> as {preview.invitedRole}.
            </div>

            {status === 'authenticated' && (
              <div style={styles.notice}>
                You&apos;re currently signed in as {user?.displayName || user?.username}. Redeeming this invite will
                create a new account and sign you into it.
              </div>
            )}

            {submitError && <div style={styles.error}>{submitError}</div>}

            <form onSubmit={handleSubmit}>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="invite-username">Choose a username</label>
                <input
                  id="invite-username"
                  style={styles.input}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="invite-password">Choose a password</label>
                <input
                  id="invite-password"
                  type="password"
                  style={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <button type="submit" style={styles.button} disabled={submitting}>
                {submitting ? 'Please wait…' : 'Accept invitation'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
