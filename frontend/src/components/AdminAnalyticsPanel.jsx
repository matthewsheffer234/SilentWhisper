import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import { getAnalyticsActivity, getDormantChannels, getMembershipGraph, getInteractionTrend, getSentimentTrend } from '../api/adminAnalytics.js';
import { listOrganizations } from '../api/organizations.js';
import { listAllWorkspacesAdmin, listChannels } from '../api/workspaces.js';
import { listAdminUsers } from '../api/admin.js';

// FEATURE_REQUEST.md's Admin Analytics Dashboard entries (activity/
// engagement metrics; collaboration structure and interaction trend;
// aggregate semantic/sentiment trend). Every value rendered here comes from
// GET /api/admin/analytics/* — aggregate counts over message metadata
// (created_at/channel_id/user_id/parent_message_id), channel_members, and
// (sentiment only) message_sentiment_scores, never message content, always
// excluding DM/group-DM channels. No charting library exists in this
// frontend and none is added here (Rules of Engagement: no external CDNs);
// every tab uses the same "dense table plus a plain CSS width-percentage
// bar per row" treatment already established elsewhere in this app's admin
// UI.

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
  barFill: (pct) => ({ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: 'var(--brg)' }),
  barCell: { display: 'flex', alignItems: 'center', gap: 8 },
  caveat: {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    background: 'var(--surface-alt)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '8px 10px',
    marginBottom: 14,
  },
  caveatProminent: {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    background: 'var(--surface-alt)',
    border: '1px solid #c0392b',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 14,
    fontWeight: 600,
  },
};

function formatBucket(value, bucket) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const formatted = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  return bucket === 'week' ? `Week of ${formatted}` : formatted;
}

function personLabel(person) {
  if (!person) return 'Unknown';
  return person.displayName || person.username || person.userId;
}

// Shared scope picker for every tab (Activity's message-activity section,
// Collaboration's two sections, Sentiment). `allowedScopes` is a subset of
// ['organization', 'workspace', 'channel', 'user'] — each caller passes
// only what its backend route actually accepts, so a request can never
// 400 on a scope this UI itself offered. `organizations`/`workspaces` are
// fetched once by the parent panel and shared across tabs/sections rather
// than re-fetched per picker.
function ScopeSelector({ allowedScopes, organizations, workspaces, value, onChange, idPrefix }) {
  const { scopeType, organizationId, workspaceId, channelId, userId } = value;
  const [channels, setChannels] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (scopeType !== 'channel' || !workspaceId) {
      setChannels([]);
      return;
    }
    listChannels(workspaceId)
      .then(setChannels)
      .catch(() => setChannels([]));
  }, [scopeType, workspaceId]);

  useEffect(() => {
    if (scopeType !== 'user' || users.length > 0) return;
    // Same v1 scope-selector limitation as the workspace picker below — the
    // first 200 accounts, not paginated. A user-scoped query still works
    // for anyone outside that set by other means later; this is a picker
    // convenience, not the authorization boundary.
    listAdminUsers({ limit: 200 })
      .then((res) => setUsers(res.users))
      .catch(() => setUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeType]);

  function update(patch) {
    onChange({ ...value, ...patch });
  }

  return (
    <div style={styles.scopeRow}>
      <div style={styles.field}>
        <label style={styles.label} htmlFor={`${idPrefix}-scope`}>Scope</label>
        <select
          id={`${idPrefix}-scope`}
          style={styles.select}
          value={scopeType}
          onChange={(e) => update({ scopeType: e.target.value, organizationId: '', workspaceId: '', channelId: '', userId: '' })}
        >
          <option value="all">Every organization</option>
          {allowedScopes.includes('organization') && <option value="organization">Organization</option>}
          {allowedScopes.includes('workspace') && <option value="workspace">Workspace</option>}
          {allowedScopes.includes('channel') && <option value="channel">Channel</option>}
          {allowedScopes.includes('user') && <option value="user">User (individual — logged)</option>}
        </select>
      </div>
      {scopeType === 'organization' && (
        <div style={styles.field}>
          <label style={styles.label} htmlFor={`${idPrefix}-org`}>Organization</label>
          <select id={`${idPrefix}-org`} style={styles.select} value={organizationId} onChange={(e) => update({ organizationId: e.target.value })}>
            <option value="">Select…</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
        </div>
      )}
      {(scopeType === 'workspace' || scopeType === 'channel') && (
        <div style={styles.field}>
          <label style={styles.label} htmlFor={`${idPrefix}-workspace`}>Workspace</label>
          <select id={`${idPrefix}-workspace`} style={styles.select} value={workspaceId} onChange={(e) => update({ workspaceId: e.target.value })}>
            <option value="">Select…</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>
      )}
      {scopeType === 'channel' && (
        <div style={styles.field}>
          <label style={styles.label} htmlFor={`${idPrefix}-channel`}>Channel</label>
          <select id={`${idPrefix}-channel`} style={styles.select} value={channelId} onChange={(e) => update({ channelId: e.target.value })} disabled={!workspaceId}>
            <option value="">Select…</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
            ))}
          </select>
        </div>
      )}
      {scopeType === 'user' && (
        <div style={styles.field}>
          <label style={styles.label} htmlFor={`${idPrefix}-user`}>User</label>
          <select id={`${idPrefix}-user`} style={styles.select} value={userId} onChange={(e) => update({ userId: e.target.value })}>
            <option value="">Select…</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>{u.displayName || u.username}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const EMPTY_SCOPE_VALUE = { scopeType: 'all', organizationId: '', workspaceId: '', channelId: '', userId: '' };

function resolveScope(value) {
  if (value.scopeType === 'organization') return { scope: 'organization', scopeId: value.organizationId };
  if (value.scopeType === 'workspace') return { scope: 'workspace', scopeId: value.workspaceId };
  if (value.scopeType === 'channel') return { scope: 'channel', scopeId: value.channelId };
  if (value.scopeType === 'user') return { scope: 'user', scopeId: value.userId };
  return { scope: undefined, scopeId: undefined };
}

// A scope requiring a picked id (anything but "all") that hasn't been
// picked yet isn't ready to query — the caller renders an empty state
// instead of firing a request that would 400.
function scopeReady(value) {
  const { scope, scopeId } = resolveScope(value);
  return !scope || Boolean(scopeId);
}

function ActivityTab({ organizations, workspaces }) {
  const [scopeValue, setScopeValue] = useState(EMPTY_SCOPE_VALUE);
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
    if (!scopeReady(scopeValue)) {
      setBuckets([]);
      setLoading(false);
      return;
    }
    const { scope, scopeId } = resolveScope(scopeValue);
    setLoading(true);
    setError(null);
    getAnalyticsActivity({ scope, scopeId, windowDays, bucket })
      .then((res) => setBuckets(res.buckets))
      .catch((err) => setError(err.message || 'Failed to load activity'))
      .finally(() => setLoading(false));
  }, [scopeValue, windowDays, bucket]);

  useEffect(() => {
    setDormantLoading(true);
    setDormantError(null);
    getDormantChannels({ windowDays: dormantWindowDays })
      .then(setDormantChannels)
      .catch((err) => setDormantError(err.message || 'Failed to load dormant channels'))
      .finally(() => setDormantLoading(false));
  }, [dormantWindowDays]);

  const maxMessageCount = Math.max(1, ...buckets.map((b) => b.messageCount));

  return (
    <div>
      <ScopeSelector allowedScopes={['organization', 'workspace', 'channel']} organizations={organizations} workspaces={workspaces} value={scopeValue} onChange={setScopeValue} idPrefix="activity" />
      <div style={styles.scopeRow}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="analytics-window">Window (days)</label>
          <input id="analytics-window" type="number" min={1} max={365} style={styles.input} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 1)} />
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

      <div style={styles.sectionTitle}>Dormant channels</div>
      <div style={{ ...styles.field, marginBottom: 10 }}>
        <label style={styles.label} htmlFor="dormant-window">No activity for at least (days)</label>
        <input id="dormant-window" type="number" min={1} max={365} style={styles.input} value={dormantWindowDays} onChange={(e) => setDormantWindowDays(Number(e.target.value) || 1)} />
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

function CollaborationTab({ organizations, workspaces }) {
  const [graphScopeValue, setGraphScopeValue] = useState(EMPTY_SCOPE_VALUE);
  const [minSharedChannels, setMinSharedChannels] = useState(2);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState(null);

  const [trendScopeValue, setTrendScopeValue] = useState(EMPTY_SCOPE_VALUE);
  const [windowDays, setWindowDays] = useState(30);
  const [bucket, setBucket] = useState('day');
  const [buckets, setBuckets] = useState([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState(null);

  useEffect(() => {
    if (!scopeReady(graphScopeValue)) {
      setGraph({ nodes: [], edges: [] });
      setGraphLoading(false);
      return;
    }
    const { scope, scopeId } = resolveScope(graphScopeValue);
    setGraphLoading(true);
    setGraphError(null);
    getMembershipGraph({ scope, scopeId, minSharedChannels })
      .then(setGraph)
      .catch((err) => setGraphError(err.message || 'Failed to load the membership graph'))
      .finally(() => setGraphLoading(false));
  }, [graphScopeValue, minSharedChannels]);

  useEffect(() => {
    if (!scopeReady(trendScopeValue)) {
      setBuckets([]);
      setTrendLoading(false);
      return;
    }
    const { scope, scopeId } = resolveScope(trendScopeValue);
    setTrendLoading(true);
    setTrendError(null);
    getInteractionTrend({ scope, scopeId, windowDays, bucket })
      .then((res) => setBuckets(res.buckets))
      .catch((err) => setTrendError(err.message || 'Failed to load the interaction trend'))
      .finally(() => setTrendLoading(false));
  }, [trendScopeValue, windowDays, bucket]);

  const nodesById = new Map(graph.nodes.map((n) => [n.userId, n]));
  const maxReplyCount = Math.max(1, ...buckets.map((b) => b.replyCount));

  return (
    <div>
      <div style={styles.sectionTitle}>Membership overlap</div>
      <div style={styles.caveat}>
        A snapshot, not a trend — channel membership carries no join date. Pairs sharing at or below the shared-channel
        threshold are omitted entirely, not shown with a low count.
      </div>
      <ScopeSelector allowedScopes={['organization', 'workspace']} organizations={organizations} workspaces={workspaces} value={graphScopeValue} onChange={setGraphScopeValue} idPrefix="collab-graph" />
      <div style={{ ...styles.field, marginBottom: 10 }}>
        <label style={styles.label} htmlFor="min-shared-channels">Minimum shared channels</label>
        <input id="min-shared-channels" type="number" min={0} max={1000} style={styles.input} value={minSharedChannels} onChange={(e) => setMinSharedChannels(Number(e.target.value) || 0)} />
      </div>
      {graphError && <div style={styles.error}>{graphError}</div>}
      {graphLoading ? (
        <div style={styles.empty}>Loading…</div>
      ) : graph.edges.length === 0 ? (
        <div style={styles.empty}>No pairs cross that threshold in this scope.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Person</th>
              <th style={styles.th}>Person</th>
              <th style={styles.th}>Shared channels</th>
            </tr>
          </thead>
          <tbody>
            {graph.edges
              .slice()
              .sort((a, b) => b.sharedChannels - a.sharedChannels)
              .map((edge) => (
                <tr key={`${edge.userA}-${edge.userB}`}>
                  <td style={styles.td}>{personLabel(nodesById.get(edge.userA))}</td>
                  <td style={styles.td}>{personLabel(nodesById.get(edge.userB))}</td>
                  <td style={styles.td}>{edge.sharedChannels}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <div style={{ ...styles.sectionTitle, marginTop: 24 }}>Interaction trend</div>
      <ScopeSelector allowedScopes={['organization', 'workspace', 'channel']} organizations={organizations} workspaces={workspaces} value={trendScopeValue} onChange={setTrendScopeValue} idPrefix="collab-trend" />
      <div style={styles.scopeRow}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="collab-window">Window (days)</label>
          <input id="collab-window" type="number" min={1} max={365} style={styles.input} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 1)} />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="collab-bucket">Bucket</label>
          <select id="collab-bucket" style={styles.select} value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </div>
      </div>
      {trendError && <div style={styles.error}>{trendError}</div>}
      {trendLoading ? (
        <div style={styles.empty}>Loading…</div>
      ) : buckets.length === 0 ? (
        <div style={styles.empty}>No cross-person replies in this scope/window.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{bucket === 'week' ? 'Week' : 'Day'}</th>
              <th style={styles.th}>Replies</th>
              <th style={styles.th}>Distinct pairs</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.bucket}>
                <td style={styles.td}>{formatBucket(b.bucket, bucket)}</td>
                <td style={styles.td}>
                  <div style={styles.barCell}>
                    <span>{b.replyCount}</span>
                    <div style={styles.barTrack}>
                      <div style={styles.barFill((b.replyCount / maxReplyCount) * 100)} />
                    </div>
                  </div>
                </td>
                <td style={styles.td}>{b.distinctPairCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SentimentTab({ organizations, workspaces }) {
  const [scopeValue, setScopeValue] = useState({ ...EMPTY_SCOPE_VALUE, scopeType: 'workspace' });
  const [windowDays, setWindowDays] = useState(30);
  const [bucket, setBucket] = useState('day');
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!scopeReady(scopeValue)) {
      setBuckets([]);
      setLoading(false);
      return;
    }
    const { scope, scopeId } = resolveScope(scopeValue);
    setLoading(true);
    setError(null);
    getSentimentTrend({ scope, scopeId, windowDays, bucket })
      .then((res) => setBuckets(res.buckets))
      .catch((err) => setError(err.message || 'Failed to load the sentiment trend'))
      .finally(() => setLoading(false));
  }, [scopeValue, windowDays, bucket]);

  return (
    <div>
      <div style={scopeValue.scopeType === 'user' ? styles.caveatProminent : styles.caveat}>
        Approximate tone signal derived from message embeddings — not a clinical or HR measurement.
        {scopeValue.scopeType === 'user' && ' Viewing an individual user’s trend is logged.'}
      </div>
      <ScopeSelector allowedScopes={['organization', 'workspace', 'channel', 'user']} organizations={organizations} workspaces={workspaces} value={scopeValue} onChange={setScopeValue} idPrefix="sentiment" />
      <div style={styles.scopeRow}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="sentiment-window">Window (days)</label>
          <input id="sentiment-window" type="number" min={1} max={365} style={styles.input} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 1)} />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="sentiment-bucket">Bucket</label>
          <select id="sentiment-bucket" style={styles.select} value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </div>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : buckets.length === 0 ? (
        <div style={styles.empty}>No bucket in this scope/window has enough scored messages to show.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{bucket === 'week' ? 'Week' : 'Day'}</th>
              <th style={styles.th}>Average tone (-1 to 1)</th>
              <th style={styles.th}>Messages</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.bucket}>
                <td style={styles.td}>{formatBucket(b.bucket, bucket)}</td>
                <td style={styles.td}>
                  <div style={styles.barCell}>
                    <span>{b.avgScore.toFixed(2)}</span>
                    <div style={styles.barTrack}>
                      <div style={styles.barFill(((b.avgScore + 1) / 2) * 100)} />
                    </div>
                  </div>
                </td>
                <td style={styles.td}>{b.messageCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TABS = [
  { key: 'activity', label: 'Activity', render: (props) => <ActivityTab {...props} /> },
  { key: 'collaboration', label: 'Collaboration', render: (props) => <CollaborationTab {...props} /> },
  { key: 'sentiment', label: 'Sentiment Trends', render: (props) => <SentimentTab {...props} /> },
];

export default function AdminAnalyticsPanel({ onClose }) {
  const [activeTab, setActiveTab] = useState(TABS[0].key);
  const [organizations, setOrganizations] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const current = TABS.find((t) => t.key === activeTab) ?? TABS[0];

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

  return (
    <Sheet
      title="Admin Analytics"
      ariaLabel="admin analytics"
      subtitle="Usage and coordination metadata only — message counts, active users, quiet channels, structural collaboration, and approximate tone. No message content is ever read."
      onClose={onClose}
      width={900}
      maxHeight="86vh"
    >
      <div style={styles.tabBar}>
        {TABS.map((tab) => (
          <button key={tab.key} type="button" style={styles.tab(tab.key === activeTab)} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>
      {current.render({ organizations, workspaces })}
    </Sheet>
  );
}
