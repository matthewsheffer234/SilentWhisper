import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import { getAnalyticsActivity, getDormantChannels } from '../api/adminAnalytics.js';
import { listOrganizations } from '../api/organizations.js';
import { listAllWorkspacesAdmin, listChannels } from '../api/workspaces.js';

// FEATURE_REQUEST.md entry 5 (Admin Analytics Dashboard — activity and
// engagement metrics). Every value rendered here comes from
// GET /api/admin/analytics/activity and .../dormant-channels — aggregate
// counts over messages.created_at/channel_id/user_id and channel_members,
// never message content, always excluding DM/group-DM channels. This is a
// tabbed shell (`tabs` below) that entries 6/7 (Collaboration,
// Sentiment Trends) extend with additional tabs sharing this same scope
// selector, rate limiter, and DM-exclusion rule — only the Activity tab
// exists today. No charting library exists in this frontend and none is
// added here (Rules of Engagement: no external CDNs); both tables below use
// the same "dense table plus a plain CSS width-percentage bar per row"
// treatment already established elsewhere in this app's admin UI.

const styles = {
  tabBar: { display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--border)' },
  tab: (active) => ({
    minHeight: 40,
    padding: '0 14px',
    border: 'none',
    borderBottom: active ? '2px solid var(--brg)' : '2px solid transparent',
    background: 'none',
    color: active ? 'var(--text-1)' : 'var(--text-3)',
    fontWeight: active ? 700 : 500,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  }),
  scopeRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 },
  label: {
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  select: {
    minHeight: 40,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  input: {
    minHeight: 40,
    width: 90,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  sectionTitle: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)', margin: '18px 0 8px' },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: '8px 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    background: 'var(--surface-alt)',
    color: 'var(--text-3)',
    fontWeight: 700,
    fontSize: 'var(--text-xs)',
    textTransform: 'uppercase',
  },
  td: { padding: '6px 8px', borderTop: '1px solid var(--border)', color: 'var(--text-1)', verticalAlign: 'middle' },
  barTrack: { width: 120, height: 8, borderRadius: 4, background: 'var(--surface-alt)', overflow: 'hidden' },
  barFill: (pct) => ({ width: `${pct}%`, height: '100%', background: 'var(--brg)' }),
  barCell: { display: 'flex', alignItems: 'center', gap: 8 },
};

function formatBucket(value, bucket) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const formatted = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  return bucket === 'week' ? `Week of ${formatted}` : formatted;
}

function ActivityTab() {
  const [scopeType, setScopeType] = useState('all');
  const [organizations, setOrganizations] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [organizationId, setOrganizationId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [windowDays, setWindowDays] = useState(30);
  const [bucket, setBucket] = useState('day');
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [dormantWindowDays, setDormantWindowDays] = useState(30);
  const [dormantChannels, setDormantChannels] = useState([]);
  const [dormantLoading, setDormantLoading] = useState(true);
  const [dormantError, setDormantError] = useState(null);

  useEffect(() => {
    listOrganizations().then(setOrganizations).catch(() => setOrganizations([]));
    // v1 scope-selector data source, not an exhaustive admin listing — a
    // deployment with more workspaces than this can still scope by
    // organization or channel-within-a-known-workspace; a fuller picker is
    // a reasonable, non-blocking follow-on once this dashboard sees real use.
    listAllWorkspacesAdmin({ limit: 200 })
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(() => {
    if (scopeType !== 'channel' || !workspaceId) {
      setChannels([]);
      setChannelId('');
      return;
    }
    listChannels(workspaceId)
      .then((rows) => setChannels(rows))
      .catch(() => setChannels([]));
  }, [scopeType, workspaceId]);

  function loadActivity() {
    const scope = scopeType === 'all' ? undefined : scopeType;
    const scopeId = scopeType === 'organization' ? organizationId : scopeType === 'workspace' || scopeType === 'channel' ? (scopeType === 'channel' ? channelId : workspaceId) : undefined;
    if (scope && !scopeId) {
      setBuckets([]);
      return;
    }
    setLoading(true);
    setError(null);
    getAnalyticsActivity({ scope, scopeId, windowDays, bucket })
      .then((res) => setBuckets(res.buckets))
      .catch((err) => setError(err.message || 'Failed to load activity'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeType, organizationId, workspaceId, channelId, windowDays, bucket]);

  function loadDormant() {
    setDormantLoading(true);
    setDormantError(null);
    getDormantChannels({ windowDays: dormantWindowDays })
      .then(setDormantChannels)
      .catch((err) => setDormantError(err.message || 'Failed to load dormant channels'))
      .finally(() => setDormantLoading(false));
  }

  useEffect(() => {
    loadDormant();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dormantWindowDays]);

  const maxMessageCount = Math.max(1, ...buckets.map((b) => b.messageCount));

  return (
    <div>
      <div style={styles.scopeRow}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="analytics-scope">Scope</label>
          <select
            id="analytics-scope"
            style={styles.select}
            value={scopeType}
            onChange={(e) => {
              setScopeType(e.target.value);
              setOrganizationId('');
              setWorkspaceId('');
              setChannelId('');
            }}
          >
            <option value="all">Every organization</option>
            <option value="organization">Organization</option>
            <option value="workspace">Workspace</option>
            <option value="channel">Channel</option>
          </select>
        </div>
        {scopeType === 'organization' && (
          <div style={styles.field}>
            <label style={styles.label} htmlFor="analytics-org">Organization</label>
            <select id="analytics-org" style={styles.select} value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              <option value="">Select…</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>
        )}
        {(scopeType === 'workspace' || scopeType === 'channel') && (
          <div style={styles.field}>
            <label style={styles.label} htmlFor="analytics-workspace">Workspace</label>
            <select
              id="analytics-workspace"
              style={styles.select}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              <option value="">Select…</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}
        {scopeType === 'channel' && (
          <div style={styles.field}>
            <label style={styles.label} htmlFor="analytics-channel">Channel</label>
            <select id="analytics-channel" style={styles.select} value={channelId} onChange={(e) => setChannelId(e.target.value)} disabled={!workspaceId}>
              <option value="">Select…</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
          </div>
        )}
        <div style={styles.field}>
          <label style={styles.label} htmlFor="analytics-window">Window (days)</label>
          <input
            id="analytics-window"
            type="number"
            min={1}
            max={365}
            style={styles.input}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value) || 1)}
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="analytics-bucket">Bucket</label>
          <select id="analytics-bucket" style={styles.select} value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </div>
      </div>

      <div style={styles.sectionTitle}>Message activity</div>
      {error && <div style={styles.error}>{error}</div>}
      {loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : buckets.length === 0 ? (
        <div style={styles.empty}>No message activity in this scope/window.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{bucket === 'week' ? 'Week' : 'Day'}</th>
              <th style={styles.th}>Messages</th>
              <th style={styles.th}>Active users</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.bucket}>
                <td style={styles.td}>{formatBucket(b.bucket, bucket)}</td>
                <td style={styles.td}>
                  <div style={styles.barCell}>
                    <span>{b.messageCount}</span>
                    <div style={styles.barTrack}>
                      <div style={styles.barFill((b.messageCount / maxMessageCount) * 100)} />
                    </div>
                  </div>
                </td>
                <td style={styles.td}>{b.activeUserCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ ...styles.scopeRow, marginTop: 20 }}>
        <div style={styles.sectionTitle}>Dormant channels</div>
      </div>
      <div style={{ ...styles.field, marginBottom: 10 }}>
        <label style={styles.label} htmlFor="dormant-window">No activity for at least (days)</label>
        <input
          id="dormant-window"
          type="number"
          min={1}
          max={365}
          style={styles.input}
          value={dormantWindowDays}
          onChange={(e) => setDormantWindowDays(Number(e.target.value) || 1)}
        />
      </div>
      {dormantError && <div style={styles.error}>{dormantError}</div>}
      {dormantLoading ? (
        <div style={styles.empty}>Loading…</div>
      ) : dormantChannels.length === 0 ? (
        <div style={styles.empty}>No channels have gone quiet in this window.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Channel</th>
              <th style={styles.th}>Workspace</th>
              <th style={styles.th}>Organization</th>
              <th style={styles.th}>Days quiet</th>
            </tr>
          </thead>
          <tbody>
            {dormantChannels.map((row) => (
              <tr key={row.channelId}>
                <td style={styles.td}>{row.channelName}</td>
                <td style={styles.td}>{row.workspaceName}</td>
                <td style={styles.td}>{row.organizationName}</td>
                <td style={styles.td}>{row.daysSinceActivity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TABS = [{ key: 'activity', label: 'Activity', render: () => <ActivityTab /> }];

export default function AdminAnalyticsPanel({ onClose }) {
  const [activeTab, setActiveTab] = useState(TABS[0].key);
  const current = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  return (
    <Sheet
      title="Admin Analytics"
      ariaLabel="admin analytics"
      subtitle="Usage and coordination metadata only — message counts, active users, and quiet channels. No message content is ever read."
      onClose={onClose}
      width={860}
      maxHeight="86vh"
    >
      <div style={styles.tabBar}>
        {TABS.map((tab) => (
          <button key={tab.key} type="button" style={styles.tab(tab.key === activeTab)} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>
      {current.render()}
    </Sheet>
  );
}
