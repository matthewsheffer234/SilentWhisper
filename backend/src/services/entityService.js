import { ValidationError, ConflictError } from '../errors.js';

export const ENTITY_RE = /\[\[([^\[\]]{1,255})\]\]/g;
export const MAX_ENTITIES_PER_MESSAGE = 20;

// FEATURE_REQUEST.md entry 4: editable entity metadata. A small fixed set
// rather than a free-text field — matching users.status/invitations.status'
// existing "app-layer enum, no DB CHECK constraint" convention (validation.js
// assertEnum is what actually enforces this at the API boundary).
export const ENTITY_STATUSES = ['ACTIVE', 'DEPRECATED', 'ARCHIVED'];

// FEATURE_REQUEST.md entry 4: entity_relationships.relationship_type. Fixed,
// small, and symmetric-agnostic (the UI/route layer decides source vs.
// target) rather than open text, so relationships stay queryable/groupable
// rather than accumulating synonyms ("depends on" vs. "requires").
export const RELATIONSHIP_TYPES = ['DEPENDS_ON', 'OWNED_BY', 'RELATED_TO', 'BLOCKS', 'PART_OF'];

export const MAX_ALIASES = 20;
export const MAX_ALIAS_LENGTH = 255;

export function normalizeEntityName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function extractEntityNames(content) {
  const entities = new Map();
  for (const match of String(content ?? '').matchAll(ENTITY_RE)) {
    const canonicalName = match[1].trim().replace(/\s+/g, ' ');
    const normalizedName = normalizeEntityName(canonicalName);
    if (!normalizedName || entities.has(normalizedName)) continue;
    entities.set(normalizedName, { canonicalName, normalizedName });
    if (entities.size >= MAX_ENTITIES_PER_MESSAGE) break;
  }
  return [...entities.values()];
}

async function findEntityByName(db, workspaceId, normalizedName) {
  return db('entities')
    .where({ workspace_id: workspaceId })
    .andWhere(function whereNameOrAlias() {
      this.where('normalized_name', normalizedName).orWhereRaw('? = ANY(aliases)', [normalizedName]);
    })
    .first('id', 'canonical_name', 'normalized_name');
}

async function findOrCreateEntity(db, { workspaceId, canonicalName, normalizedName, createdBy }) {
  const existing = await findEntityByName(db, workspaceId, normalizedName);
  if (existing) return existing;

  const [inserted] = await db('entities')
    .insert({
      workspace_id: workspaceId,
      canonical_name: canonicalName,
      normalized_name: normalizedName,
      created_by: createdBy,
    })
    .onConflict(['workspace_id', 'normalized_name'])
    .ignore()
    .returning(['id', 'canonical_name', 'normalized_name']);

  if (inserted) return inserted;

  return findEntityByName(db, workspaceId, normalizedName);
}

// FEATURE_REQUEST.md entry 4: "alias normalization/collision behavior."
// Aliases are stored normalized (matching how the aliases column is already
// queried elsewhere in this file/entities.js — `? = ANY(aliases)` against a
// normalized query string), deduped case/whitespace-insensitively within the
// submitted list, and rejected outright if any normalized alias collides
// with another entity's canonical name or alias set in the same workspace —
// silently overwriting the collision would let two different entities
// resolve to the same [[bracket]] text, breaking the extraction/resolve
// paths' "exactly one entity per name per workspace" invariant.
export async function normalizeAndValidateAliases(db, { workspaceId, entityId, aliases }) {
  if (!Array.isArray(aliases)) {
    throw new ValidationError('aliases must be an array');
  }
  if (aliases.length > MAX_ALIASES) {
    throw new ValidationError(`aliases must have at most ${MAX_ALIASES} entries`);
  }

  const normalizedAliases = [];
  const seen = new Set();
  for (const raw of aliases) {
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_ALIAS_LENGTH) {
      throw new ValidationError(`each alias must be 1-${MAX_ALIAS_LENGTH} characters`);
    }
    const normalized = normalizeEntityName(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedAliases.push(normalized);
  }

  if (normalizedAliases.length === 0) return [];

  const collision = await db('entities')
    .where('workspace_id', workspaceId)
    .andWhere('id', '<>', entityId)
    .andWhere(function whereCollides() {
      this.whereIn('normalized_name', normalizedAliases).orWhereRaw('aliases && ?::varchar[]', [normalizedAliases]);
    })
    .first('id', 'canonical_name');
  if (collision) {
    throw new ConflictError(`Alias conflicts with existing entity "${collision.canonical_name}"`);
  }

  return normalizedAliases;
}

// FEATURE_REQUEST.md entry 3 (message editing): reconciles message_entities
// against the freshly-extracted set rather than only ever appending —
// correct both at creation (nothing existing to remove, so the reconcile
// deletes zero rows) and on a later edit, where a [[Entity]] token can
// genuinely be removed and a stale reference would otherwise linger
// forever, incorrectly counting toward that entity's
// referenceCount/trending/SME attribution. Always reconciles rather than
// only doing so when called for an edit specifically — message_id is the
// leading column of message_entities' own composite primary key, so the
// delete is a cheap indexed no-op on the common creation-with-no-entities
// path, not worth a second job_type/call-site distinction to avoid.
export async function linkMessageEntities(db, { content, messageId, workspaceId, createdBy }) {
  if (!workspaceId) return [];

  const extracted = extractEntityNames(content);
  if (extracted.length === 0) {
    await db('message_entities').where({ message_id: messageId }).del();
    return [];
  }

  const resolved = [];
  for (const entity of extracted) {
    // eslint-disable-next-line no-await-in-loop
    const row = await findOrCreateEntity(db, { workspaceId, createdBy, ...entity });
    if (row) resolved.push(row);
  }

  if (resolved.length === 0) {
    await db('message_entities').where({ message_id: messageId }).del();
    return [];
  }

  const resolvedIds = resolved.map((entity) => entity.id);
  await db('message_entities').where({ message_id: messageId }).whereNotIn('entity_id', resolvedIds).del();
  await db('message_entities')
    .insert(resolved.map((entity) => ({ message_id: messageId, entity_id: entity.id })))
    .onConflict(['message_id', 'entity_id'])
    .ignore();

  return resolved;
}
