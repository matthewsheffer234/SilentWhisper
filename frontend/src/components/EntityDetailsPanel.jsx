import { useEffect, useRef, useState } from 'react';
import { Hash, X } from 'lucide-react';
import Sheet from './Sheet.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import {
  getEntity,
  listEntityReferences,
  searchEntities,
  updateEntity,
  createEntityRelationship,
  deleteEntityRelationship,
  generateEntitySummary,
} from '../api/entities.js';
import { searchWorkspaceMembers } from '../api/workspaces.js';
import { renderMessageContent } from '../markdown.jsx';

// FEATURE_REQUEST.md entry 4: entity_relationships.relationship_type — kept
// in sync by hand with backend/src/services/entityService.js's
// RELATIONSHIP_TYPES, the same "no shared-code mechanism between frontend
// and backend" convention frontend/src/authz/permissions.js's own header
// comment already documents for permissions.
const RELATIONSHIP_TYPES = [
  { value: 'DEPENDS_ON', label: 'Depends on' },
  { value: 'OWNED_BY', label: 'Owned by' },
  { value: 'RELATED_TO', label: 'Related to' },
  { value: 'BLOCKS', label: 'Blocks' },
  { value: 'PART_OF', label: 'Part of' },
];
const ENTITY_STATUSES = ['ACTIVE', 'DEPRECATED', 'ARCHIVED'];
const DEBOUNCE_MS = 200;

const styles = {
  sectionTitle: {
    marginTop: 14,
    marginBottom: 8,
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  description: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    whiteSpace: 'pre-wrap',
  },
  aliases: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  alias: {
    padding: '3px 8px',
    borderRadius: 999,
    background: 'var(--surface-alt)',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
  },
  references: { display: 'flex', flexDirection: 'column', gap: 10 },
  reference: {
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
  },
  referenceMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    color: 'var(--text-3)',
    fontSize: 'var(--text-xs)',
  },
  referenceContent: { color: 'var(--text-1)', fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  muted: { color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)' },
  loadMore: {
    minHeight: 40,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    fontWeight: 600,
  },
  metaRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  badge: {
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--surface-alt)',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
  },
  editToggle: {
    minHeight: 32,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  input: {
    minHeight: 38,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
    width: '100%',
  },
  textarea: {
    minHeight: 70,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
    width: '100%',
    resize: 'vertical',
    fontFamily: 'inherit',
  },
  select: {
    minHeight: 38,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  inlineForm: { display: 'flex', gap: 6, alignItems: 'flex-start' },
  actionButton: {
    minHeight: 38,
    padding: '0 12px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  feedback: { fontSize: 'var(--text-xs)', marginTop: 2 },
  feedbackError: { color: '#c0392b' },
  feedbackSuccess: { color: 'var(--brg)' },
  fieldLabel: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginBottom: 2 },
  relationshipRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    marginBottom: 6,
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
  },
  removeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 24,
    minHeight: 24,
    borderRadius: '50%',
    border: 'none',
    background: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
  },
  taskRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 10px',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
  },
  taskChecked: { color: 'var(--text-3)', textDecoration: 'line-through' },
  summaryBox: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    whiteSpace: 'pre-wrap',
  },
  summaryMeta: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginTop: 6 },
  pickerWrap: { position: 'relative', flex: 1, minWidth: 0 },
  pickerDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    maxHeight: 200,
    overflowY: 'auto',
    background: 'var(--overlay-bg)',
    boxShadow: 'var(--overlay-shadow)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    zIndex: 60,
  },
  pickerOption: { padding: '8px 12px', cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
};

// Minimal entity search-and-select combobox for choosing a relationship
// target — deliberately not a PeoplePicker generalization (that component is
// keyed on `userId`/`username`/`displayName` throughout; entities have
// `id`/`canonicalName`), just the same debounce/dropdown shape scoped down
// to this one use.
function EntityPicker({ workspaceId, excludeEntityId, value, onChange }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function scheduleSearch(q) {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const rows = await searchEntities(workspaceId, q);
        setResults(rows.filter((r) => r.id !== excludeEntityId));
      } catch {
        setResults([]);
      }
    }, DEBOUNCE_MS);
  }

  if (value) {
    return (
      <span style={{ ...styles.badge, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {value.canonicalName}
        <button
          type="button"
          style={{ ...styles.removeButton, minWidth: 18, minHeight: 18 }}
          onClick={() => onChange(null)}
          aria-label={`Remove ${value.canonicalName}`}
        >
          <X size={10} aria-hidden="true" />
        </button>
      </span>
    );
  }

  return (
    <div style={styles.pickerWrap} ref={wrapRef}>
      <input
        style={styles.input}
        value={query}
        placeholder="Search entities…"
        aria-label="Search entities for relationship target"
        onFocus={() => {
          setOpen(true);
          if (results === null) scheduleSearch('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          scheduleSearch(e.target.value);
        }}
      />
      {open && results && (
        <div style={styles.pickerDropdown}>
          {results.length === 0 && <div style={{ ...styles.muted, padding: '8px 12px' }}>No matching entities.</div>}
          {results.map((r) => (
            <div
              key={r.id}
              className="sl-row"
              style={styles.pickerOption}
              onClick={() => {
                onChange(r);
                setQuery('');
                setOpen(false);
                setResults(null);
              }}
            >
              {r.canonicalName}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditMetadataSection({ workspaceId, entity, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(entity.description ?? '');
  const [status, setStatus] = useState(entity.status ?? 'ACTIVE');
  const [tags, setTags] = useState((entity.tags ?? []).join(', '));
  const [referenceUrl, setReferenceUrl] = useState(entity.referenceUrl ?? '');
  const [owner, setOwner] = useState(
    entity.ownerId ? { userId: entity.ownerId, username: entity.ownerUsername, displayName: entity.ownerDisplayName } : null,
  );
  const [saveStatus, setSaveStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  function startEditing() {
    setDescription(entity.description ?? '');
    setStatus(entity.status ?? 'ACTIVE');
    setTags((entity.tags ?? []).join(', '));
    setReferenceUrl(entity.referenceUrl ?? '');
    setOwner(entity.ownerId ? { userId: entity.ownerId, username: entity.ownerUsername, displayName: entity.ownerDisplayName } : null);
    setSaveStatus(null);
    setEditing(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaveStatus(null);
    try {
      const updated = await updateEntity(workspaceId, entity.id, {
        description: description.trim() === '' ? null : description.trim(),
        status,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        referenceUrl: referenceUrl.trim() === '' ? null : referenceUrl.trim(),
        ownerId: owner ? owner.userId : null,
      });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err.message || 'Failed to update entity' });
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div>
        <div style={styles.metaRow}>
          <span style={styles.badge}>{entity.status ?? 'ACTIVE'}</span>
          {entity.ownerUsername && <span>Owner: {entity.ownerDisplayName || entity.ownerUsername}</span>}
          <button type="button" style={styles.editToggle} onClick={startEditing}>
            Edit
          </button>
        </div>
        {entity.tags?.length > 0 && (
          <div style={{ ...styles.aliases, marginBottom: 8 }}>
            {entity.tags.map((tag) => (
              <span key={tag} style={styles.alias}>{tag}</span>
            ))}
          </div>
        )}
        {entity.referenceUrl && (
          <div style={{ marginBottom: 8 }}>
            <a href={entity.referenceUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--brg)', fontSize: 'var(--text-sm)' }}>
              {entity.referenceUrl}
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <form style={styles.form} onSubmit={handleSave}>
      <div>
        <div style={styles.fieldLabel}>Description</div>
        <textarea style={styles.textarea} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div style={styles.inlineForm}>
        <div style={{ flex: 1 }}>
          <div style={styles.fieldLabel}>Status</div>
          <select style={styles.select} value={status} onChange={(e) => setStatus(e.target.value)}>
            {ENTITY_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <div style={styles.fieldLabel}>Owner</div>
          <PeoplePicker
            searchFn={(q) => searchWorkspaceMembers(workspaceId, q)}
            value={owner}
            onChange={setOwner}
            placeholder="Search workspace members"
            ariaLabel="Search workspace members for entity owner"
          />
        </div>
      </div>
      <div>
        <div style={styles.fieldLabel}>Tags (comma-separated)</div>
        <input style={styles.input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="infra, staging" />
      </div>
      <div>
        <div style={styles.fieldLabel}>Reference URL</div>
        <input
          style={styles.input}
          value={referenceUrl}
          onChange={(e) => setReferenceUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" style={styles.actionButton} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" style={styles.editToggle} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {saveStatus && (
        <div style={{ ...styles.feedback, ...(saveStatus.type === 'error' ? styles.feedbackError : styles.feedbackSuccess) }}>
          {saveStatus.message}
        </div>
      )}
    </form>
  );
}

function RelationshipsSection({ workspaceId, entity, onChanged }) {
  const [target, setTarget] = useState(null);
  const [relationshipType, setRelationshipType] = useState(RELATIONSHIP_TYPES[0].value);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setStatus(null);
    try {
      await createEntityRelationship(workspaceId, entity.id, { targetEntityId: target.id, relationshipType });
      setTarget(null);
      await onChanged();
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create relationship' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(relationshipId) {
    setBusy(true);
    setStatus(null);
    try {
      await deleteEntityRelationship(workspaceId, entity.id, relationshipId);
      await onChanged();
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to remove relationship' });
    } finally {
      setBusy(false);
    }
  }

  const relationships = entity.relationships ?? [];

  return (
    <div>
      {relationships.length === 0 && <div style={styles.muted}>No relationships yet.</div>}
      {relationships.map((r) => (
        <div key={r.id} style={styles.relationshipRow}>
          <span>
            {r.direction === 'outgoing'
              ? `${RELATIONSHIP_TYPES.find((t) => t.value === r.relationshipType)?.label ?? r.relationshipType} ${r.relatedEntity.canonicalName}`
              : `${r.relatedEntity.canonicalName} ${(RELATIONSHIP_TYPES.find((t) => t.value === r.relationshipType)?.label ?? r.relationshipType).toLowerCase()} this`}
          </span>
          <button
            type="button"
            style={styles.removeButton}
            disabled={busy}
            onClick={() => handleRemove(r.id)}
            aria-label="Remove relationship"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
      <form style={{ ...styles.inlineForm, marginTop: 8 }} onSubmit={handleAdd}>
        <EntityPicker workspaceId={workspaceId} excludeEntityId={entity.id} value={target} onChange={setTarget} />
        <select style={styles.select} value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)}>
          {RELATIONSHIP_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button type="submit" style={styles.actionButton} disabled={!target || busy}>
          Add
        </button>
      </form>
      {status && <div style={{ ...styles.feedback, ...styles.feedbackError }}>{status.message}</div>}
    </div>
  );
}

function LinkedActionItemsSection({ items }) {
  if (!items || items.length === 0) {
    return <div style={styles.muted}>No linked action items.</div>;
  }
  return (
    <div>
      {items.map((task) => (
        <div key={`${task.messageId}:${task.taskIndex}`} style={styles.taskRow}>
          <span>{task.checked ? '☑' : '☐'}</span>
          <span style={task.checked ? styles.taskChecked : undefined}>
            {task.text}
            {task.owner && <span style={{ color: 'var(--text-3)' }}> — @{task.owner}</span>}
            <span style={{ color: 'var(--text-3)' }}> (#{task.channelName})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function EntitySummarySection({ workspaceId, entity, onUpdated }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const summary = await generateEntitySummary(workspaceId, entity.id);
      onUpdated({ ...entity, summary });
    } catch (err) {
      setError(err.message || 'Failed to generate summary');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      {entity.summary ? (
        <>
          <div style={styles.summaryBox}>{entity.summary.text}</div>
          <div style={styles.summaryMeta}>
            Generated {new Date(entity.summary.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} via{' '}
            {entity.summary.provider}, from {entity.summary.citations?.length ?? 0} reference
            {entity.summary.citations?.length === 1 ? '' : 's'}.
          </div>
        </>
      ) : (
        <div style={styles.muted}>No summary generated yet.</div>
      )}
      <button type="button" style={{ ...styles.editToggle, marginTop: 8 }} onClick={handleGenerate} disabled={generating}>
        {generating ? 'Generating…' : entity.summary ? 'Regenerate summary' : 'Generate summary'}
      </button>
      {error && <div style={{ ...styles.feedback, ...styles.feedbackError }}>{error}</div>}
    </div>
  );
}

export default function EntityDetailsPanel({ workspaceId, entityId, initialEntity, onClose }) {
  const [entity, setEntity] = useState(initialEntity ?? null);
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getEntity(workspaceId, entityId), listEntityReferences(workspaceId, entityId, { limit: 20 })])
      .then(([details, refs]) => {
        if (cancelled) return;
        setEntity(details);
        setReferences(refs);
        setHasMore(refs.length === 20);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load entity');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, entityId]);

  async function loadMore() {
    const last = references[references.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const more = await listEntityReferences(workspaceId, entityId, { limit: 20, before: last.createdAt });
      setReferences((prev) => [...prev, ...more]);
      setHasMore(more.length === 20);
    } catch (err) {
      setError(err.message || 'Failed to load references');
    } finally {
      setLoadingMore(false);
    }
  }

  // Relationship create/remove change another entity's own detail too (the
  // other side of the relationship), so the simplest correct refresh is
  // refetching this entity's own detail rather than trying to locally patch
  // a nested relationships array — relationships are edited rarely enough
  // that the extra round trip is not a real cost.
  async function refreshEntity() {
    const details = await getEntity(workspaceId, entityId);
    setEntity(details);
  }

  const title = entity?.canonicalName ?? initialEntity?.canonicalName ?? 'Entity';

  return (
    <Sheet ariaLabel={`${title} entity details`} title={title} subtitle="Entity profile" onClose={onClose} width={620} maxHeight="86vh">
      {loading && <div style={styles.muted}>Loading entity…</div>}
      {error && <div style={styles.error}>{error}</div>}
      {entity && !loading && (
        <>
          <div style={styles.sectionTitle}>Summary</div>
          <EditMetadataSection workspaceId={workspaceId} entity={entity} onUpdated={setEntity} />
          <div style={styles.description}>{entity.description || 'No description yet.'}</div>
          {entity.aliases?.length > 0 && (
            <>
              <div style={styles.sectionTitle}>Aliases</div>
              <div style={styles.aliases}>
                {entity.aliases.map((alias) => (
                  <span key={alias} style={styles.alias}>{alias}</span>
                ))}
              </div>
            </>
          )}

          <div style={styles.sectionTitle}>What we know (AI-generated)</div>
          <EntitySummarySection workspaceId={workspaceId} entity={entity} onUpdated={setEntity} />

          <div style={styles.sectionTitle}>Related entities</div>
          <RelationshipsSection workspaceId={workspaceId} entity={entity} onChanged={refreshEntity} />

          <div style={styles.sectionTitle}>Linked action items</div>
          <LinkedActionItemsSection items={entity.linkedActionItems} />

          <div style={styles.sectionTitle}>{entity.referenceCount} reference{entity.referenceCount === 1 ? '' : 's'}</div>
          <div style={styles.references}>
            {references.length === 0 && <div style={styles.muted}>No visible references.</div>}
            {references.map((ref) => (
              <div key={ref.messageId} style={styles.reference}>
                <div style={styles.referenceMeta}>
                  <Hash size={12} aria-hidden="true" />
                  <span>{ref.channelName}</span>
                  <span>·</span>
                  <span>{ref.displayName || ref.username}</span>
                  <span>·</span>
                  <span>{new Date(ref.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
                <div style={styles.referenceContent}>{renderMessageContent(ref.content)}</div>
              </div>
            ))}
            {hasMore && (
              <button type="button" style={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
