export const ENTITY_RE = /\[\[([^\[\]]{1,255})\]\]/g;
export const MAX_ENTITIES_PER_MESSAGE = 20;

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

export async function linkMessageEntities(db, { content, messageId, workspaceId, createdBy }) {
  if (!workspaceId) return [];

  const extracted = extractEntityNames(content);
  if (extracted.length === 0) return [];

  const resolved = [];
  for (const entity of extracted) {
    // eslint-disable-next-line no-await-in-loop
    const row = await findOrCreateEntity(db, { workspaceId, createdBy, ...entity });
    if (row) resolved.push(row);
  }

  if (resolved.length === 0) return [];

  await db('message_entities')
    .insert(resolved.map((entity) => ({ message_id: messageId, entity_id: entity.id })))
    .onConflict(['message_id', 'entity_id'])
    .ignore();

  return resolved;
}
