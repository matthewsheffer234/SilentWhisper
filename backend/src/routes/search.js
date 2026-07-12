import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember, requireWorkspaceMember } from '../authz/membershipService.js';
import { assertUuid, assertBoundedInt, assertSearchQuery } from '../validation.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { embedText, toVectorLiteral } from '../search/embeddingService.js';
import { semanticSearchRateLimiter } from '../llm/aiRateLimit.js';

export const searchRouter = Router();

searchRouter.use(requireAuth);

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 50;
const EXCERPT_LENGTH = 240;

function excerpt(content) {
  return content.length > EXCERPT_LENGTH ? `${content.slice(0, EXCERPT_LENGTH)}…` : content;
}

// FEATURE_REQUEST.md entry 1: conceptual search over message history via the
// configured local embedding model. `workspaceId`/`channelId` are both
// optional — omitting both searches every channel the caller belongs to.
searchRouter.post('/search/semantic', semanticSearchRateLimiter, async (req, res, next) => {
  try {
    const query = assertSearchQuery(req.body?.query);
    const limit =
      req.body?.limit !== undefined
        ? assertBoundedInt(req.body.limit, { min: 1, max: MAX_RESULT_LIMIT }, 'limit')
        : DEFAULT_RESULT_LIMIT;

    // Authorize scope *before* touching the vector index (Section 3,
    // existence-hiding: a channel/workspace the caller isn't a member of
    // 404s here exactly like every other membership check in this app,
    // never confirmed via a search result).
    let channelId = null;
    let workspaceId = null;
    if (req.body?.channelId !== undefined) {
      channelId = assertUuid(req.body.channelId, 'channelId');
      await requireChannelMember(db, req.user.id, channelId);
    }
    if (req.body?.workspaceId !== undefined) {
      workspaceId = assertUuid(req.body.workspaceId, 'workspaceId');
      await requireWorkspaceMember(db, req.user.id, workspaceId);
    }

    const queryEmbedding = await embedText(db, query);
    const vectorLiteral = toVectorLiteral(queryEmbedding);

    // The inner join to channel_members, filtered to the caller's own
    // user_id, IS the authorization boundary for the cross-channel case: a
    // message row only survives this join if a channel_members row exists
    // for (that channel, this caller) — the single-channel case is already
    // narrowed by requireChannelMember above, but a global/workspace-wide
    // query has no single membership check to lean on, so the join itself
    // must never surface a channel the caller isn't in (FEATURE_REQUEST.md
    // entry 1's explicit authorization requirement).
    let rowsQuery = db('message_embeddings as me')
      .join('messages as m', 'm.id', 'me.message_id')
      .join('channels as c', 'c.id', 'm.channel_id')
      .join('channel_members as cm', 'cm.channel_id', 'c.id')
      .join('users as u', 'u.id', 'm.user_id')
      .leftJoin('messages as pm', 'pm.id', 'm.parent_message_id')
      .leftJoin('users as pu', 'pu.id', 'pm.user_id')
      .where('cm.user_id', req.user.id)
      .select(
        'm.id as messageId',
        'm.channel_id as channelId',
        'c.workspace_id as workspaceId',
        'c.name as channelName',
        'c.type as channelType',
        'u.username',
        'm.content as content',
        'm.created_at as createdAt',
        'pm.id as parentId',
        'pm.content as parentContent',
        'pu.username as parentUsername',
        db.raw('1 - (me.embedding <=> ?::vector) as similarity', [vectorLiteral]),
      )
      .orderByRaw('me.embedding <=> ?::vector', [vectorLiteral])
      .limit(limit);

    if (channelId) {
      rowsQuery = rowsQuery.where('c.id', channelId);
    } else if (workspaceId) {
      rowsQuery = rowsQuery.where('c.workspace_id', workspaceId);
    }

    const rows = await rowsQuery;

    const results = rows.map((r) => ({
      messageId: r.messageId,
      channelId: r.channelId,
      workspaceId: r.workspaceId,
      channelName: r.channelName,
      channelType: r.channelType,
      username: r.username,
      excerpt: excerpt(r.content),
      createdAt: r.createdAt,
      similarity: Number(r.similarity),
      parentMessage: r.parentId ? { id: r.parentId, username: r.parentUsername, content: r.parentContent } : null,
    }));

    // AI-operation audit convention (Section 3): log query length and result
    // count, never the raw query text — same "length, not content" rule
    // already applied to summarize/extract-tasks' truncatedInputLength.
    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_SEMANTIC_SEARCH_REQUESTED',
      targetResource: channelId || workspaceId || null,
      payload: {
        queryLength: query.length,
        model: config.embedding.model,
        resultCount: results.length,
        workspaceId,
        channelId,
      },
    });

    res.json({ results });
  } catch (err) {
    next(err);
  }
});
