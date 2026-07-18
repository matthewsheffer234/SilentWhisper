import { useRef, useState } from 'react';
import Sheet from './Sheet.jsx';
import { requestWorkspaceDigest } from '../api/ai.js';
import { AI_DIGEST_WINDOW_OPTIONS, formatAiActionError, formatAiQueueLabel } from '../aiPresentation.js';

// FEATURE_REQUEST.md entry 6, "Cross-channel 'Catch Me Up' workspace
// digests". Scope call (documented in PROJECT_PLAN.md Section 11): sends an
// explicit `channelIds` list per request rather than reading from a
// persisted "starred channels" feature — the design's own v1 fallback when
// that table doesn't exist yet. `includeMentionsOnly` isn't a separate field
// here either, since an empty channelIds list already means "mentions only"
// on the backend — a redundant flag would just be one more thing to keep in
// sync with the checkbox state below.
const styles = {
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  label: { fontSize: 'var(--text-xs)', color: 'var(--text-2)', fontWeight: 600 },
  windowOption: (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--brg)' : 'var(--border)'}`,
    background: active ? 'var(--surface-alt)' : 'transparent',
    cursor: 'pointer',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    marginBottom: 6,
  }),
  channelList: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' },
  channelOption: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-1)', padding: '4px 2px' },
  emptyChannels: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
  submitButton: {
    minHeight: 44,
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontSize: 'var(--text-base)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelButton: {
    minHeight: 44,
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-base)',
    cursor: 'pointer',
  },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginTop: 12 },
  outputPanel: {
    marginTop: 16,
    padding: '12px 14px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    whiteSpace: 'pre-wrap',
  },
  outputScope: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginBottom: 8 },
};

export default function WorkspaceDigestPanel({ workspace, channels, onClose }) {
  const [sinceHours, setSinceHours] = useState(AI_DIGEST_WINDOW_OPTIONS[0].sinceHours);
  const [selectedChannelIds, setSelectedChannelIds] = useState([]);
  const [digest, setDigest] = useState(null); // { loading, text, error, scope }
  const abortRef = useRef(null);

  const memberChannels = channels.filter((c) => c.isMember);

  function toggleChannel(channelId) {
    setSelectedChannelIds((prev) =>
      prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId],
    );
  }

  const windowLabel = AI_DIGEST_WINDOW_OPTIONS.find((opt) => opt.sinceHours === sinceHours)?.label ?? '';

  async function handleGenerate() {
    const controller = new AbortController();
    abortRef.current = controller;
    setDigest({ loading: true, text: '', error: null, scope: windowLabel, queuePosition: null });
    try {
      await requestWorkspaceDigest(
        workspace.id,
        { sinceHours, channelIds: selectedChannelIds },
        (chunk) => {
          setDigest((prev) => (prev ? { ...prev, text: prev.text + chunk, queuePosition: null } : prev));
        },
        {
          signal: controller.signal,
          onQueued: (position) => setDigest((prev) => (prev ? { ...prev, queuePosition: position } : prev)),
        },
      );
      setDigest((prev) => (prev ? { ...prev, loading: false } : prev));
    } catch (err) {
      setDigest({ loading: false, text: '', error: formatAiActionError(err, 'Failed to generate digest'), scope: windowLabel });
    } finally {
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <Sheet ariaLabel="Catch Me Up" title="Catch Me Up" subtitle={workspace.name} onClose={onClose} width={480} maxHeight="80vh">
      <div style={styles.field}>
        <span style={styles.label}>Time window</span>
        {AI_DIGEST_WINDOW_OPTIONS.map((opt) => (
          <label key={opt.sinceHours} style={styles.windowOption(sinceHours === opt.sinceHours)}>
            <input
              type="radio"
              name="digest-window"
              checked={sinceHours === opt.sinceHours}
              onChange={() => setSinceHours(opt.sinceHours)}
              disabled={digest?.loading}
            />
            {opt.label}
          </label>
        ))}
      </div>

      <div style={styles.field}>
        <span style={styles.label}>Also include recent activity from (optional)</span>
        {memberChannels.length === 0 ? (
          <span style={styles.emptyChannels}>No channels to include yet — the digest will still cover your unread mentions.</span>
        ) : (
          <div style={styles.channelList}>
            {memberChannels.map((ch) => (
              <label key={ch.id} style={styles.channelOption}>
                <input
                  type="checkbox"
                  checked={selectedChannelIds.includes(ch.id)}
                  onChange={() => toggleChannel(ch.id)}
                  disabled={digest?.loading}
                />
                {ch.name}
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={styles.actions}>
        <button type="button" style={styles.submitButton} onClick={handleGenerate} disabled={digest?.loading}>
          {digest?.loading ? (digest.queuePosition ? formatAiQueueLabel(digest.queuePosition) : 'Generating…') : 'Generate Digest'}
        </button>
        {digest?.loading ? (
          <button type="button" style={styles.cancelButton} onClick={handleCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" style={styles.cancelButton} onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {digest && (
        <div style={styles.outputPanel}>
          <div style={styles.outputScope}>{digest.scope}</div>
          {digest.error ? (
            <div style={styles.error}>{digest.error}</div>
          ) : (
            <div>{digest.text || (digest.loading ? 'Gathering mentions and recent activity…' : '')}</div>
          )}
        </div>
      )}
    </Sheet>
  );
}
