import { useEffect, useState } from 'react';
import { getAiSettings, updateAiSettings } from '../api/ai.js';

// PROJECT_PLAN.md Section 6: "Admins can inspect the active provider, model,
// timeout, token limits, streaming support, and prompt versions" and "Admins
// can update non-secret LLM settings later without rebuilding the frontend."
// Gated server-side (requireSystemPermission) — this component is only ever
// rendered for a user ChatShell has already determined is OWNER/MANAGER of
// at least one workspace (or a system admin), but the backend enforces it
// regardless.

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  panel: {
    width: 480,
    maxWidth: '92vw',
    maxHeight: '86vh',
    overflowY: 'auto',
    background: 'var(--surface)',
    borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
    padding: '20px 24px',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-1)' },
  // 44px minimum tap target (PROJECT_PLAN.md Section 7) — the visible × glyph
  // stays small; the invisible hit box around it is full-size.
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-lg)',
  },
  subtitle: { fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 16 },
  healthRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    marginBottom: 16,
  },
  dot: (healthy) => ({
    width: 9,
    height: 9,
    borderRadius: '50%',
    background: healthy ? 'var(--brg)' : '#c0392b',
    flexShrink: 0,
  }),
  field: { marginBottom: 14 },
  label: { display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  row: { display: 'flex', gap: 12 },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  saveButton: {
    marginTop: 6,
    minHeight: 44,
    padding: '0 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  saved: { color: 'var(--brg)', fontSize: 'var(--text-sm)', marginLeft: 12 },
};

export default function AiSettingsPanel({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    getAiSettings()
      .then((data) => {
        setSettings(data);
        setForm(data);
      })
      .catch((err) => setError(err.message || 'Failed to load AI settings'));
  }, []);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const patch = {
        provider: form.provider,
        baseUrl: form.baseUrl,
        model: form.model,
        timeoutMs: Number(form.timeoutMs),
        maxInputChars: Number(form.maxInputChars),
        maxOutputTokens: Number(form.maxOutputTokens),
        maxConcurrentRequests: Number(form.maxConcurrentRequests),
        temperature: Number(form.temperature),
        streamingEnabled: Boolean(form.streamingEnabled),
        summaryPromptVersion: form.summaryPromptVersion,
        taskPromptVersion: form.taskPromptVersion,
      };
      const updated = await updateAiSettings(patch);
      setSettings(updated);
      setForm(updated);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.message || 'Failed to save AI settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>AI Settings</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close AI settings">×</button>
        </div>
        <div style={styles.subtitle}>Configure the local LLM provider used for channel summaries and task extraction.</div>

        {error && <div style={styles.error}>{error}</div>}

        {settings && (
          <div style={styles.healthRow}>
            <span style={styles.dot(settings.health?.healthy)} />
            <span>
              {settings.health?.healthy ? 'Provider reachable' : 'Provider unreachable'}
              {settings.health?.message ? ` — ${settings.health.message}` : ''}
              {settings.health?.lastCheckedAt
                ? ` (checked ${new Date(settings.health.lastCheckedAt).toLocaleTimeString()})`
                : ''}
            </span>
          </div>
        )}

        {form && (
          <form onSubmit={handleSave}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="ai-provider">Provider</label>
              <select
                id="ai-provider"
                style={styles.select}
                value={form.provider}
                onChange={(e) => updateField('provider', e.target.value)}
              >
                <option value="ollama">Ollama</option>
                <option value="vllm">vLLM</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="ai-base-url">Base URL</label>
              <input
                id="ai-base-url"
                style={styles.input}
                value={form.baseUrl}
                onChange={(e) => updateField('baseUrl', e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="ai-model">Model</label>
              <input id="ai-model" style={styles.input} value={form.model} onChange={(e) => updateField('model', e.target.value)} />
            </div>

            <div style={styles.row}>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-timeout">Timeout (ms)</label>
                <input
                  id="ai-timeout"
                  type="number"
                  style={styles.input}
                  value={form.timeoutMs}
                  onChange={(e) => updateField('timeoutMs', e.target.value)}
                />
              </div>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-temperature">Temperature</label>
                <input
                  id="ai-temperature"
                  type="number"
                  step="0.1"
                  style={styles.input}
                  value={form.temperature}
                  onChange={(e) => updateField('temperature', e.target.value)}
                />
              </div>
            </div>

            <div style={styles.row}>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-max-input">Max input chars</label>
                <input
                  id="ai-max-input"
                  type="number"
                  style={styles.input}
                  value={form.maxInputChars}
                  onChange={(e) => updateField('maxInputChars', e.target.value)}
                />
              </div>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-max-output">Max output tokens</label>
                <input
                  id="ai-max-output"
                  type="number"
                  style={styles.input}
                  value={form.maxOutputTokens}
                  onChange={(e) => updateField('maxOutputTokens', e.target.value)}
                />
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="ai-max-concurrent">Max concurrent requests</label>
              <input
                id="ai-max-concurrent"
                type="number"
                style={styles.input}
                value={form.maxConcurrentRequests}
                onChange={(e) => updateField('maxConcurrentRequests', e.target.value)}
              />
            </div>

            <div style={styles.row}>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-summary-version">Summary prompt version</label>
                <input
                  id="ai-summary-version"
                  style={styles.input}
                  value={form.summaryPromptVersion}
                  onChange={(e) => updateField('summaryPromptVersion', e.target.value)}
                />
              </div>
              <div style={{ ...styles.field, flex: 1 }}>
                <label style={styles.label} htmlFor="ai-task-version">Task prompt version</label>
                <input
                  id="ai-task-version"
                  style={styles.input}
                  value={form.taskPromptVersion}
                  onChange={(e) => updateField('taskPromptVersion', e.target.value)}
                />
              </div>
            </div>

            <div style={{ ...styles.field, ...styles.checkboxRow }}>
              <input
                id="ai-streaming"
                type="checkbox"
                checked={Boolean(form.streamingEnabled)}
                onChange={(e) => updateField('streamingEnabled', e.target.checked)}
              />
              <label htmlFor="ai-streaming">Stream responses incrementally</label>
            </div>

            <button type="submit" style={styles.saveButton} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {savedAt && <span style={styles.saved}>Saved</span>}
          </form>
        )}
      </div>
    </div>
  );
}
