import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import { getAuditLogs, verifyAuditLog } from '../api/audit.js';

// PROJECT_PLAN.md Section 6: "An admin-only dashboard displays recent audit
// events." Section 3: viewing it is the one intentional exception to
// "private channels/DMs are never readable via admin tooling," and that
// exception is itself audited server-side on every page load — this
// component doesn't need to know that; it just calls GET /api/audit/logs
// like any other admin-gated read. Uses the shared Sheet primitive
// (FEATURE_REQUEST.md's "standard modal/sheet component" entry).

const styles = {
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  verifyButton: {
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: '1px solid var(--brg)',
    background: 'none',
    color: 'var(--brg)',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  verifyResult: { fontSize: 'var(--text-sm)', fontWeight: 600 },
  verifyOk: { color: 'var(--brg)' },
  verifyBad: { color: '#c0392b' },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  tableWrap: { flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: 'var(--surface-alt)',
    color: 'var(--text-3)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    position: 'sticky',
    top: 0,
  },
  td: { padding: '8px 10px', borderTop: '1px solid var(--border)', color: 'var(--text-1)', verticalAlign: 'top' },
  actionType: { fontWeight: 600 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-xs)', color: 'var(--text-2)' },
  loadMore: {
    marginTop: 12,
    alignSelf: 'center',
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  empty: { padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
};

function formatPayload(payload) {
  if (!payload) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export default function AuditDashboard({ onClose }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [verifyState, setVerifyState] = useState(null); // { loading, result, error }

  useEffect(() => {
    getAuditLogs({ limit: 50 })
      .then((data) => {
        setRows(data);
        setHasMore(data.length === 50);
      })
      .catch((err) => setError(err.message || 'Failed to load audit log'))
      .finally(() => setLoading(false));
  }, []);

  async function handleLoadMore() {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const oldestId = rows[rows.length - 1].id;
      const next = await getAuditLogs({ limit: 50, beforeId: oldestId });
      setRows((prev) => [...prev, ...next]);
      setHasMore(next.length === 50);
    } catch (err) {
      setError(err.message || 'Failed to load more audit events');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleVerify() {
    setVerifyState({ loading: true, result: null, error: null });
    try {
      const result = await verifyAuditLog();
      setVerifyState({ loading: false, result, error: null });
    } catch (err) {
      setVerifyState({ loading: false, result: null, error: err.message || 'Verification failed to run' });
    }
  }

  return (
    <Sheet
      title="Audit Log"
      ariaLabel="audit log"
      subtitle="Recent security-relevant events, oldest to newest reversed. Viewing this is itself an audited action."
      onClose={onClose}
      width={820}
      maxHeight="86vh"
    >
        <div style={styles.toolbar}>
          <button type="button" style={styles.verifyButton} onClick={handleVerify} disabled={verifyState?.loading}>
            {verifyState?.loading ? 'Verifying…' : 'Verify Integrity'}
          </button>
          {verifyState?.result && (
            <span style={{ ...styles.verifyResult, ...(verifyState.result.verified ? styles.verifyOk : styles.verifyBad) }}>
              {verifyState.result.verified
                ? `Log Integrity Verified (${verifyState.result.rowsChecked} rows)`
                : `Integrity check failed at row ${verifyState.result.firstFailure?.id}: ${verifyState.result.firstFailure?.reason}`}
            </span>
          )}
          {verifyState?.error && <span style={{ ...styles.verifyResult, ...styles.verifyBad }}>{verifyState.error}</span>}
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.tableWrap}>
          {loading ? (
            <div style={styles.empty}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={styles.empty}>No audit events yet.</div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Time</th>
                  <th style={styles.th}>Actor</th>
                  <th style={styles.th}>Action</th>
                  <th style={styles.th}>Target</th>
                  <th style={styles.th}>Payload</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={styles.td}>{new Date(row.timestamp).toLocaleString()}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{row.actorId}</td>
                    <td style={{ ...styles.td, ...styles.actionType }}>{row.actionType}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{row.targetResource ?? ''}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{formatPayload(row.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {hasMore && rows.length > 0 && (
          <button type="button" style={styles.loadMore} onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
    </Sheet>
  );
}
