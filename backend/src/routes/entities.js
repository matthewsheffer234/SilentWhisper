import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireWorkspaceMember, getWorkspaceRole } from '../authz/membershipService.js';
import { entitySearchLimiter, entityTrendingLimiter, entityExpertsLimiter } from '../auth/rateLimit.js';
import { aiEntitySummaryRateLimiter } from '../llm/aiRateLimit.js';
import { assertUuid, assertBoundedInt, assertShortString, assertEnum, assertHttpUrl, parseOffsetPagination } from '../validation.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  normalizeEntityName,
  normalizeAndValidateAliases,
  ENTITY_STATUSES,
  RELATIONSHIP_TYPES,
} from '../services/entityService.js';
import { parseTasks } from '../services/taskParser.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { generateEntitySummary } from '../services/entitySummaryService.js';

export const entitiesRouter = Router();

entitiesRouter.use(requireAuth);

const ENTITY_SEARCH_DEFAULT_LIMIT = 8;
const ENTITY_SEARCH_MAX_LIMIT = 8;
const ENTITY_QUERY_MAX_LENGTH = 255;
const ENTITY_REFERENCES_DEFAULT_LIMIT = 20;
const ENTITY_REFERENCES_MAX_LIMIT = 50;
const ENTITY_DESCRIPTION_MAX_LENGTH = 4000;
// FEATURE_REQUEST.md entry 2 (Knowledge Explorer). A deployment can narrow
// the default trending window per-request; this is just a sanity cap on how
// far back a single request may ever reach — same precedent as
// tasks.js's MAX_TASK_DASHBOARD_WINDOW_DAYS.
const KNOWLEDGE_EXPLORER_TRENDING_MAX_WINDOW_DAYS = 365;
const ENTITY_EXPERTS_DEFAULT_LIMIT = 5;
const ENTITY_EXPERTS_MAX_LIMIT = 20;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;
// Bounds how many of an entity's authorized references the AI summary and
// the linked-action-items scan ever look at — same "bounded window, not an
// unbounded scan" instinct as tasks.js's dashboard and workspaceDigestService.
const ENTITY_SUMMARY_MAX_REFERENCES = 40;

function serializeEntity(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    aliases: row.aliases ?? [],
    description: row.description ?? null,
    ownerId: row.owner_id ?? null,
    ownerUsername: row.owner_username ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    status: row.status ?? 'ACTIVE',
    tags: row.tags ?? [],
    referenceUrl: row.reference_url ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeRelationship(row, fromEntityId) {
  const outgoing = row.source_entity_id === fromEntityId;
  return {
    id: row.id,
    relationshipType: row.relationship_type,
    direction: outgoing ? 'outgoing' : 'incoming',
    relatedEntity: {
      id: outgoing ? row.target_entity_id : row.source_entity_id,
      canonicalName: outgoing ? row.target_canonical_name : row.source_canonical_name,
    },
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  };
}

function serializeSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.summary_text,
    citations: row.citations,
    provider: row.provider,
    promptVersion: row.prompt_version,
    generatedBy: row.generated_by ?? null,
    generatedAt: row.generated_at,
  };
}

// tasks.js's own two-step pattern (a cheap SQL narrowing, then the real
// tokenizer): here the "narrowing" is already done for us by referencesQuery
// (channel-membership-authorized, bounded) — this just runs parseTasks()
// over already-fetched, already-authorized rows rather than issuing a
// second query. FEATURE_REQUEST.md entry 4: "surface... owner-tagged tasks
// as linked action items."
function extractLinkedActionItems(referenceRows) {
  const items = [];
  for (const row of referenceRows) {
    for (const task of parseTasks(row.content)) {
      items.push({
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        taskIndex: task.index,
        checked: task.checked,
        text: task.text,
        owner: task.owner,
        messageCreatedAt: row.created_at,
      });
    }
  }
  return items;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) {
    throw new ValidationError('tags must be an array');
  }
  if (tags.length > MAX_TAGS) {
    throw new ValidationError(`tags must have at most ${MAX_TAGS} entries`);
  }
  const seen = new Set();
  for (const tag of tags) {
    assertShortString(tag, { maxLength: MAX_TAG_LENGTH }, 'tag');
    seen.add(tag.trim().toLowerCase());
  }
  return [...seen];
}

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Citation History): mirrors
// exactly how GET /api/search/semantic already embeds parentMessage on a
// threaded-reply hit (routes/search.js) — parentMessageId already told a
// caller *whether* a reference is a reply, this adds what the parent
// actually said so the UI can show thread context without a second fetch.
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
    parentMessage: row.parent_message_id
      ? {
          id: row.parent_message_id,
          content: row.parent_content,
          username: row.parent_username,
          displayName: row.parent_display_name,
          createdAt: row.parent_created_at,
        }
      : null,
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

// Left-joins the owner (if any) so every call site gets full serializable
// detail for free — cheap (one extra indexed join on a primary key) and
// keeps serializeEntity's owner-display fields populated everywhere this is
// used, rather than only on the detail route.
async function requireWorkspaceEntity(workspaceId, entityId) {
  const entity = await db('entities as e')
    .leftJoin('users as owner', 'owner.id', 'e.owner_id')
    .where('e.id', entityId)
    .andWhere('e.workspace_id', workspaceId)
    .first('e.*', 'owner.username as owner_username', 'owner.display_name as owner_display_name');
  if (!entity) {
    throw new NotFoundError('Entity not found');
  }
  return entity;
}

function loadRelationships(workspaceId, entityId) {
  return db('entity_relationships as r')
    .join('entities as s', 's.id', 'r.source_entity_id')
    .join('entities as t', 't.id', 'r.target_entity_id')
    .where('r.workspace_id', workspaceId)
    .andWhere(function whereInvolvesEntity() {
      this.where('r.source_entity_id', entityId).orWhere('r.target_entity_id', entityId);
    })
    .orderBy('r.created_at', 'desc')
    .select(
      'r.id',
      'r.relationship_type',
      'r.source_entity_id',
      'r.target_entity_id',
      'r.created_by',
      'r.created_at',
      's.canonical_name as source_canonical_name',
      't.canonical_name as target_canonical_name',
    );
}

function loadLatestSummary(entityId) {
  return db('entity_summaries').where({ entity_id: entityId }).orderBy('generated_at', 'desc').first();
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
    .leftJoin('messages as pm', 'pm.id', 'm.parent_message_id')
    .leftJoin('users as pu', 'pu.id', 'pm.user_id')
    .where('e.id', entityId)
    .where('e.workspace_id', workspaceId)
    .where('c.workspace_id', workspaceId);
}

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Trending Entities): the
// ungrouped version of referencesQuery's exact join shape, minus the
// entity_id filter — an entity referenced only in a channel the caller isn't
// a member of contributes zero rows to the eventual GROUP BY (structural
// privacy, not a filter layered on afterward), identical reasoning to
// referencesQuery's own channel_members join.
function trendingEntitiesBaseQuery({ workspaceId, userId, since }) {
  return db('message_entities as me')
    .join('entities as e', 'e.id', 'me.entity_id')
    .join('messages as m', 'm.id', 'me.message_id')
    .join('channels as c', 'c.id', 'm.channel_id')
    .join('channel_members as cm', function joinMembership() {
      this.on('cm.channel_id', '=', 'c.id').andOn('cm.user_id', '=', db.raw('?', [userId]));
    })
    .where('e.workspace_id', workspaceId)
    .where('c.workspace_id', workspaceId)
    .where('m.created_at', '>=', since);
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

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Trending Entities). Must
// stay defined before GET /entities/:entityId — Express matches routes in
// definition order, and "trending" is not a UUID, so it has to be caught
// here rather than falling into the :entityId param (matching why
// /search and /resolve above are already defined ahead of it too).
entitiesRouter.get('/workspaces/:workspaceId/entities/trending', entityTrendingLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);

    const windowDays =
      req.query.windowDays !== undefined
        ? assertBoundedInt(req.query.windowDays, { min: 1, max: KNOWLEDGE_EXPLORER_TRENDING_MAX_WINDOW_DAYS }, 'windowDays')
        : config.knowledgeExplorer.trendingWindowDays;
    const { limit, offset } = parseOffsetPagination(req.query);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // Privacy is structural here, not a filter bolted on afterward: the
    // inner join to channel_members (inside trendingEntitiesBaseQuery)
    // means an entity referenced only in a channel the caller isn't a
    // member of contributes zero rows to this GROUP BY — it never appears
    // with a `referenceCount: 0` placeholder that would itself leak
    // existence, it simply isn't in the result set.
    const rows = await trendingEntitiesBaseQuery({ workspaceId, userId: req.user.id, since })
      .groupBy('e.id', 'e.canonical_name')
      .orderByRaw('count(*) desc, e.id asc')
      .limit(limit)
      .offset(offset)
      .select('e.id', 'e.canonical_name', db.raw('count(*)::int as reference_count'));

    const totalRow = await trendingEntitiesBaseQuery({ workspaceId, userId: req.user.id, since })
      .countDistinct('e.id as count')
      .first();

    res.json({
      entities: rows.map((r) => ({ id: r.id, canonicalName: r.canonical_name, referenceCount: Number(r.reference_count) })),
      total: Number(totalRow?.count ?? 0),
      limit,
      offset,
      windowDays,
    });
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
        'pm.content as parent_content',
        'pu.username as parent_username',
        'pu.display_name as parent_display_name',
        'pm.created_at as parent_created_at',
      );

    const [relationshipRows, latestSummary] = await Promise.all([
      loadRelationships(workspaceId, entityId),
      loadLatestSummary(entityId),
    ]);

    res.json({
      ...serializeEntity(entity),
      referenceCount: Number(countRow?.reference_count ?? 0),
      recentReferences: referenceRows.map(serializeReference),
      // Derived from the same authorized, bounded reference set already
      // fetched above — never a second, wider query. A private-channel
      // reference the caller can't see contributes neither a reference nor a
      // linked action item, for the identical reason it's already absent
      // from recentReferences.
      linkedActionItems: extractLinkedActionItems(referenceRows),
      relationships: relationshipRows.map((r) => serializeRelationship(r, entityId)),
      summary: serializeSummary(latestSummary),
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
        'pm.content as parent_content',
        'pu.username as parent_username',
        'pu.display_name as parent_display_name',
        'pm.created_at as parent_created_at',
      );

    res.json(rows.map(serializeReference));
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Subject Matter Experts).
// Reuses referencesQuery() unmodified — the identical caller-scoped join
// /references and /:entityId already use — just grouped by contributor
// instead of ordered by recency. Same structural-privacy guarantee: a user
// whose only contributions to this entity are in a channel the caller can't
// read simply never appears as a row for that caller.
entitiesRouter.get('/workspaces/:workspaceId/entities/:entityId/experts', entityExpertsLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const limit =
      req.query.limit !== undefined
        ? assertBoundedInt(req.query.limit, { min: 1, max: ENTITY_EXPERTS_MAX_LIMIT }, 'limit')
        : ENTITY_EXPERTS_DEFAULT_LIMIT;

    const rows = await referencesQuery({ workspaceId, entityId, userId: req.user.id })
      .groupBy('u.id', 'u.username', 'u.display_name')
      .orderByRaw('count(*) desc, u.id asc')
      .limit(limit)
      .select('u.id as user_id', 'u.username', 'u.display_name', db.raw('count(*)::int as reference_count'));

    res.json(
      rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        referenceCount: Number(r.reference_count),
      })),
    );
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md entry 4: editable entity metadata. Gated on plain
// workspace membership, the same bar message-send/[[Entity]] extraction
// already clears — entities are a collaborative, wiki-like artifact built
// out of ordinary channel messages, not an admin-tier resource, so this
// deliberately does not introduce a role-gated permission for a single
// consumer (authz/permissions.js's own stated convention against unused
// abstraction). Every field is independently optional in the body — only
// keys actually present are validated/updated, so a client can patch just
// `status` without resending the rest.
entitiesRouter.patch('/workspaces/:workspaceId/entities/:entityId', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const body = req.body ?? {};
    const update = {};
    const fieldsChanged = [];

    if (body.description !== undefined) {
      update.description =
        body.description === null ? null : assertShortString(body.description, { maxLength: ENTITY_DESCRIPTION_MAX_LENGTH }, 'description');
      fieldsChanged.push('description');
    }
    if (body.aliases !== undefined) {
      update.aliases = await normalizeAndValidateAliases(db, { workspaceId, entityId, aliases: body.aliases });
      fieldsChanged.push('aliases');
    }
    if (body.status !== undefined) {
      update.status = assertEnum(body.status, ENTITY_STATUSES, 'status');
      fieldsChanged.push('status');
    }
    if (body.tags !== undefined) {
      update.tags = validateTags(body.tags);
      fieldsChanged.push('tags');
    }
    if (body.referenceUrl !== undefined) {
      update.reference_url = body.referenceUrl === null ? null : assertHttpUrl(body.referenceUrl, 'referenceUrl');
      fieldsChanged.push('referenceUrl');
    }
    if (body.ownerId !== undefined) {
      if (body.ownerId === null) {
        update.owner_id = null;
      } else {
        const ownerId = assertUuid(body.ownerId, 'ownerId');
        const ownerRole = await getWorkspaceRole(db, ownerId, workspaceId);
        if (!ownerRole) {
          throw new ValidationError('ownerId must be a member of this workspace');
        }
        update.owner_id = ownerId;
      }
      fieldsChanged.push('ownerId');
    }

    if (fieldsChanged.length === 0) {
      throw new ValidationError('No updatable fields provided');
    }

    update.updated_at = db.fn.now();
    await db('entities').where({ id: entityId, workspace_id: workspaceId }).update(update);
    const updated = await requireWorkspaceEntity(workspaceId, entityId);

    // Never the description/alias/tag text itself in the audit payload —
    // matching this codebase's absolute "never log raw content" convention
    // (payload carries lengths/counts/flags everywhere else, not the text).
    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ENTITY_METADATA_UPDATED',
      targetResource: entityId,
      payload: {
        workspaceId,
        fieldsChanged,
        status: updated.status,
        hasOwner: Boolean(updated.owner_id),
        tagCount: updated.tags?.length ?? 0,
        aliasCount: updated.aliases?.length ?? 0,
      },
    });

    res.json(serializeEntity(updated));
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md entry 4: entity_relationships. Symmetric authorization
// with the metadata route above — any workspace member may propose a
// relationship, matching the same "collaborative wiki, not an admin
// resource" reasoning.
entitiesRouter.post('/workspaces/:workspaceId/entities/:entityId/relationships', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const targetEntityId = assertUuid(req.body?.targetEntityId, 'targetEntityId');
    const relationshipType = assertEnum(req.body?.relationshipType, RELATIONSHIP_TYPES, 'relationshipType');
    if (targetEntityId === entityId) {
      throw new ValidationError('An entity cannot have a relationship with itself');
    }
    // 404s if targetEntityId doesn't exist or belongs to a different
    // workspace — the same existence-hiding requireWorkspaceEntity already
    // gives every other route.
    const targetEntity = await requireWorkspaceEntity(workspaceId, targetEntityId);

    let inserted;
    try {
      [inserted] = await db('entity_relationships')
        .insert({
          workspace_id: workspaceId,
          source_entity_id: entityId,
          target_entity_id: targetEntityId,
          relationship_type: relationshipType,
          created_by: req.user.id,
        })
        .returning('*');
    } catch (err) {
      if (err.code === '23505') {
        throw new ConflictError('This relationship already exists');
      }
      throw err;
    }

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ENTITY_RELATIONSHIP_CREATED',
      targetResource: inserted.id,
      payload: { workspaceId, sourceEntityId: entityId, targetEntityId, relationshipType },
    });

    res.status(201).json({
      id: inserted.id,
      relationshipType: inserted.relationship_type,
      direction: 'outgoing',
      relatedEntity: { id: targetEntity.id, canonicalName: targetEntity.canonical_name },
      createdBy: inserted.created_by,
      createdAt: inserted.created_at,
    });
  } catch (err) {
    next(err);
  }
});

entitiesRouter.delete('/workspaces/:workspaceId/entities/:entityId/relationships/:relationshipId', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    const relationshipId = assertUuid(req.params.relationshipId, 'relationshipId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const relationship = await db('entity_relationships')
      .where({ id: relationshipId, workspace_id: workspaceId })
      .andWhere(function whereInvolvesEntity() {
        this.where('source_entity_id', entityId).orWhere('target_entity_id', entityId);
      })
      .first();
    if (!relationship) {
      throw new NotFoundError('Relationship not found');
    }

    await db('entity_relationships').where({ id: relationshipId }).delete();

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ENTITY_RELATIONSHIP_REMOVED',
      targetResource: relationshipId,
      payload: {
        workspaceId,
        sourceEntityId: relationship.source_entity_id,
        targetEntityId: relationship.target_entity_id,
        relationshipType: relationship.relationship_type,
      },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md entry 4: AI-generated "What we know" summary. GET
// returns the latest cached revision only (cheap, no LLM call) so opening an
// entity page never triggers inference by itself; POST regenerates. Both
// compute/read from the same authorized reference set referencesQuery
// already restricts to channels the caller can read — a summary is never
// built from, and never cites, a reference the requesting caller couldn't
// otherwise see, even though the stored row itself is workspace-visible
// once generated (matching the design's "computed only from channels the
// caller can read" rule; the citation list is what future readers use to
// judge whether the summary might reference something outside their own
// access, since a summary generated by a broader-access member could still
// name a channel a later reader can't open).
entitiesRouter.get('/workspaces/:workspaceId/entities/:entityId/ai/summary', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceEntity(workspaceId, entityId);

    const summary = await loadLatestSummary(entityId);
    res.json(serializeSummary(summary));
  } catch (err) {
    next(err);
  }
});

entitiesRouter.post('/workspaces/:workspaceId/entities/:entityId/ai/summary', aiEntitySummaryRateLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const entityId = assertUuid(req.params.entityId, 'entityId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    const entity = await requireWorkspaceEntity(workspaceId, entityId);

    const referenceRows = await referencesQuery({ workspaceId, entityId, userId: req.user.id })
      .orderBy('m.created_at', 'desc')
      .limit(ENTITY_SUMMARY_MAX_REFERENCES)
      .select('m.id as message_id', 'm.channel_id', 'c.name as channel_name', 'm.user_id', 'u.username', 'm.content', 'm.created_at');

    if (referenceRows.length === 0) {
      throw new ValidationError('No references available to summarize for this entity yet');
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const result = await generateEntitySummary(db, {
      entityName: entity.canonical_name,
      references: referenceRows.map((r) => ({ channelName: r.channel_name, username: r.username, content: r.content })),
      signal: controller.signal,
    });

    const citations = referenceRows.map((r) => ({
      messageId: r.message_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      createdAt: r.created_at,
    }));

    const [inserted] = await db('entity_summaries')
      .insert({
        entity_id: entityId,
        summary_text: result.text,
        citations: JSON.stringify(citations),
        provider: result.provider,
        prompt_version: result.promptVersion,
        generated_by: req.user.id,
      })
      .returning('*');

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_ENTITY_SUMMARY_REQUESTED',
      targetResource: entityId,
      payload: {
        workspaceId,
        provider: result.provider,
        promptVersion: result.promptVersion,
        truncatedInputLength: result.truncatedInputLength,
        wasTruncated: result.wasTruncated,
        referenceCount: referenceRows.length,
      },
    });

    res.status(201).json(serializeSummary(inserted));
  } catch (err) {
    next(err);
  }
});
