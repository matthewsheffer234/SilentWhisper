import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireWorkspaceMember } from '../authz/membershipService.js';
import { entitySearchLimiter } from '../auth/rateLimit.js';
import { assertUuid, assertBoundedInt } from '../validation.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { normalizeEntityName } from '../services/entityService.js';

export const entitiesRouter = Router();

entitiesRouter.use(requireAuth);

const ENTITY_SEARCH_DEFAULT_LIMIT = 8;
const ENTITY_SEARCH_MAX_LIMIT = 8;
const ENTITY_QUERY_MAX_LENGTH = 255;
const ENTITY_REFERENCES_DEFAULT_LIMIT = 20;
const ENTITY_REFERENCES_MAX_LIMIT = 50;

function serializeEntity(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    aliases: row.aliases ?? [],
    description: row.description ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeReference(row) {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelType: row.channel_type,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    content: row.content,
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at,
  };
}

function parseEntityQuery(raw) {
  if (raw === undefined) return '';
  const q = String(raw);
  if (q.length > ENTITY_QUERY_MAX_LENGTH) {
    throw new ValidationError(`q must be at most ${ENTITY_QUERY_MAX_LENGTH} characters`);
  }
  return q;
}

function parseReferencePagination(query) {
  const limit =
    query.limit !== undefined
      ? assertBoundedInt(query.limit, { min: 1, max: ENTITY_REFERENCES_MAX_LIMIT }, 'limit')
      : ENTITY_REFERENCES_DEFAULT_LIMIT;
  let before = null;
  if (query.before !== undefined) {
    before = new Date(query.before);
    if (Number.isNaN(before.getTime())) {
      throw new ValidationError('before must be a valid ISO timestamp');
    }
  }
  return { limit, before };
}

async function requireWorkspaceEntity(workspaceId, entityId) {
  const entity = await db('entities').where({ id: entityId, workspace_id: workspaceId }).first();
  if (!entity) {
    throw new NotFoundError('Entity not found');
  }
  return entity;
}

function referencesQuery({ workspaceId, entityId, userId }) {
  return db('message_entities as me')
    .join('entities as e', 'e.id', 'me.entity_id')
    .join('messages as m', 'm.id', 'me.message_id')
    .join('channels as c', 'c.id', 'm.channel_id')
    .join('channel_members as cm', function joinMembership() {
      this.on('cm.channel_id', '=', 'c.id').andOn('cm.user_id', '=', db.raw('?', [userId]));
    })
    .join('users as u', 'u.id', 'm.user_id')
    .where('e.id', entityId)
    .where('e.workspace_id', workspaceId)
    .where('c.workspace_id', workspaceId);
}

entitiesRouter.get('/workspaces/:workspaceId/entities/search', entitySearchLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    const limit =
      req.query.limit !== undefined
        ? assertBoundedInt(req.query.limit, { min: 1, max: ENTITY_SEARCH_MAX_LIMIT }, 'limit')
        : ENTITY_SEARCH_DEFAULT_LIMIT;
    const q = parseEntityQuery(req.query.q);
    const normalized = normalizeEntityName(q);

    let query = db('entities').where({ workspace_id: workspaceId });
    if (normalized) {
      query = query.andWhere(function whereMatches() {
        this.where('normalized_name', 'ilike', `${normalized}%`)
          .orWhereRaw('? = ANY(aliases)', [normalized])
          .orWhereRaw('similarity(normalized_name, ?) > 0.1', [normalized]);
      });
    }

    if (normalized) {
      query = query
        .orderByRaw('CASE WHEN normalized_name ILIKE ? THEN 0 ELSE 1 END', [`${normalized}%`])
        .orderByRaw('similarity(normalized_name, ?) DESC', [normalized])
        .orderBy('canonical_name', 'asc');
    } else {
      query = query.orderBy('canonical_name', 'asc');
    }

    const rows = await query.limit(limit).select();
    res.json(rows.map(serializeEntity));
  } catch (err) {
    next(err);
  }
});

entitiesRouter.get('/workspaces/:workspaceId/entities/resolve', entitySearchLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    const name = parseEntityQuery(req.query.name);
    const normalized = normalizeEntityName(name);
    if (!normalized) {
      throw new ValidationError('name is required');
    }

    const row = await db('entities')
      .where({ workspace_id: workspaceId })
      .andWhere(function whereNameOrAlias() {
        this.where('normalized_name', normalized).orWhereRaw('? = ANY(aliases)', [normalized]);
      })
      .first();
    if (!row) {
      throw new NotFoundError('Entity not found');
    }
    res.json(serializeEntity(row));
  } catch (err) {
    next(err);
  }
});

entitiesRouter.get('/workspaces/:workspaceId/entities/:entityId', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    const entity = await requireWorkspaceEntity(workspaceId, entityId);

    const countRow = await referencesQuery({ workspaceId, entityId, userId: req.user.id }).first(
      db.raw('count(*)::int as reference_count'),
    );
    const referenceRows = await referencesQuery({ workspaceId, entityId, userId: req.user.id })
      .orderBy('m.created_at', 'desc')
      .limit(ENTITY_REFERENCES_DEFAULT_LIMIT)
      .select(
        'm.id as message_id',
        'm.channel_id',
        'c.name as channel_name',
        'c.type as channel_type',
        'm.user_id',
        'u.username',
        'u.display_name',
        'm.content',
        'm.parent_message_id',
        'm.created_at',
      );

    res.json({
      ...serializeEntity(entity),
      referenceCount: Number(countRow?.reference_count ?? 0),
      recentReferences: referenceRows.map(serializeReference),
    });
  } catch (err) {
    next(err);
  }
});

entitiesRouter.get('/workspaces/:workspaceId/entities/:entityId/references', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const { limit, before } = parseReferencePagination(req.query);
    let query = referencesQuery({ workspaceId, entityId, userId: req.user.id });
    if (before) {
      query = query.where('m.created_at', '<', before);
    }
    const rows = await query
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .select(
        'm.id as message_id',
        'm.channel_id',
        'c.name as channel_name',
        'c.type as channel_type',
        'm.user_id',
        'u.username',
        'u.display_name',
        'm.content',
        'm.parent_message_id',
        'm.created_at',
      );

    res.json(rows.map(serializeReference));
  } catch (err) {
    next(err);
  }
});
