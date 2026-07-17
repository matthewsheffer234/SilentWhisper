import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember, requireSystemPermission, requireWorkspaceMember } from '../authz/membershipService.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertBoundedInt } from '../validation.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { getEffectiveSettings, validateSettingsPatch, updateSettings } from '../llm/settingsService.js';
import { getHealthStatus } from '../llm/healthCheck.js';
import { buildSummaryPrompt, buildTaskExtractionPrompt, buildDigestPrompt } from '../llm/promptTemplates.js';
import { runStreamingCompletion } from '../llm/aiService.js';
import { aiProxyRateLimiter, aiDigestRateLimiter } from '../llm/aiRateLimit.js';
import { selectDigestMessages, DIGEST_MAX_CHANNELS } from '../services/workspaceDigestService.js';

export const aiRouter = Router();

aiRouter.use(requireAuth);

// Admin-only per PROJECT_PLAN.md Section 6 ("Admins can inspect the active
// provider..."). Gated on AI_SETTINGS_MANAGE — a system admin, or OWNER/
// MANAGER of at least one workspace (see requireSystemPermission's doc
// comment for why, given app_settings has no per-workspace scoping of its
// own).
aiRouter.get('/ai/settings', async (req, res, next) => {
  try {
    await requireSystemPermission(db, req.user.id, PERMISSIONS.AI_SETTINGS_MANAGE);
    const settings = await getEffectiveSettings(db);
    res.json({ ...settings, health: getHealthStatus() });
  } catch (err) {
    next(err);
  }
});

aiRouter.patch('/ai/settings', async (req, res, next) => {
  try {
    const { viaSystemAdminOverride } = await requireSystemPermission(db, req.user.id, PERMISSIONS.AI_SETTINGS_MANAGE);
    const patch = validateSettingsPatch(req.body ?? {});
    const settings = await updateSettings(db, patch, req.user.id);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_SETTINGS_UPDATED',
      targetResource: 'app_settings',
      payload: { ...patch, viaSystemAdminOverride },
    });

    res.json({ ...settings, health: getHealthStatus() });
  } catch (err) {
    next(err);
  }
});

// Collects recent channel messages and streams back a bullet-point summary.
// "Recent" rather than a true unread cursor — this app has no per-user
// read-state tracking table (Section 4), so recency (most recent N messages,
// bounded like message-history pagination) stands in for "unread" here.
aiRouter.post('/channels/:channelId/ai/summarize', aiProxyRateLimiter, async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireChannelMember(db, req.user.id, channelId);

    const limit =
      req.body?.limit !== undefined ? assertBoundedInt(req.body.limit, { min: 1, max: 200 }, 'limit') : 50;

    const rows = await db('messages')
      .where({ 'messages.channel_id': channelId })
      .whereNull('messages.parent_message_id')
      .join('users', 'users.id', 'messages.user_id')
      .orderBy('messages.created_at', 'desc')
      .limit(limit)
      .select('users.username', 'messages.content');

    if (rows.length === 0) {
      throw new ValidationError('No messages to summarize in this channel yet');
    }
    const messages = rows.reverse(); // oldest-first for a coherent summary

    let result;
    try {
      result = await runStreamingCompletion({
        db,
        res,
        promptBuilder: buildSummaryPrompt,
        promptVersionField: 'summaryPromptVersion',
        messages,
      });
    } catch (err) {
      // Adapter failed after the response had already started streaming —
      // the status code is locked in, so surface it by ending the body
      // rather than trying (and failing) to send a JSON error.
      if (res.headersSent) {
        // eslint-disable-next-line no-console
        console.error('AI summarize failed mid-stream:', err);
        res.end();
        return;
      }
      throw err;
    }

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_SUMMARIZE_REQUESTED',
      targetResource: channelId,
      payload: {
        provider: result.provider,
        promptVersion: result.promptVersion,
        truncatedInputLength: result.truncatedInputLength,
        wasTruncated: result.wasTruncated,
        messageCount: messages.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Parses the thread rooted at :messageId (the root message plus every reply
// with parent_message_id = messageId) and streams back an action-item
// checklist.
aiRouter.post('/messages/:messageId/ai/extract-tasks', aiProxyRateLimiter, async (req, res, next) => {
  try {
    const messageId = assertUuid(req.params.messageId, 'messageId');

    const root = await db('messages as m')
      .join('users', 'users.id', 'm.user_id')
      .where('m.id', messageId)
      .select('m.id', 'm.channel_id', 'users.username', 'm.content')
      .first();
    if (!root) {
      throw new NotFoundError('Message not found');
    }
    await requireChannelMember(db, req.user.id, root.channel_id);

    const replyRows = await db('messages as m')
      .join('users', 'users.id', 'm.user_id')
      .where('m.parent_message_id', root.id)
      .orderBy('m.created_at', 'asc')
      .select('users.username', 'm.content');

    const messages = [{ username: root.username, content: root.content }, ...replyRows];

    let result;
    try {
      result = await runStreamingCompletion({
        db,
        res,
        promptBuilder: buildTaskExtractionPrompt,
        promptVersionField: 'taskPromptVersion',
        messages,
      });
    } catch (err) {
      if (res.headersSent) {
        // eslint-disable-next-line no-console
        console.error('AI task extraction failed mid-stream:', err);
        res.end();
        return;
      }
      throw err;
    }

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_TASK_EXTRACTION_REQUESTED',
      targetResource: root.id,
      payload: {
        channelId: root.channel_id,
        provider: result.provider,
        promptVersion: result.promptVersion,
        truncatedInputLength: result.truncatedInputLength,
        wasTruncated: result.wasTruncated,
        messageCount: messages.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

const DEFAULT_DIGEST_WINDOW_HOURS = 24;

// sinceHours/sinceDays are mutually exclusive alternate units for the same
// value; assertBoundedInt's own max bound (config.llm.digestMaxWindowHours)
// is what "clamps the requested window to a configured maximum" — an
// out-of-range request 400s here rather than being silently truncated,
// matching every other bounded input in this app (message-history
// pagination, entity search limits) instead of introducing a new
// silent-clamp convention just for this one field.
function parseDigestWindowHours(body) {
  const maxHours = config.llm.digestMaxWindowHours;
  if (body?.sinceHours !== undefined && body?.sinceDays !== undefined) {
    throw new ValidationError('Specify either sinceHours or sinceDays, not both');
  }
  if (body?.sinceHours !== undefined) {
    return assertBoundedInt(body.sinceHours, { min: 1, max: maxHours }, 'sinceHours');
  }
  if (body?.sinceDays !== undefined) {
    return assertBoundedInt(body.sinceDays, { min: 1, max: Math.floor(maxHours / 24) }, 'sinceDays') * 24;
  }
  return DEFAULT_DIGEST_WINDOW_HOURS;
}

function parseDigestChannelIds(body) {
  if (body?.channelIds === undefined) return [];
  if (!Array.isArray(body.channelIds)) {
    throw new ValidationError('channelIds must be an array of channel ids');
  }
  if (body.channelIds.length > DIGEST_MAX_CHANNELS) {
    throw new ValidationError(`channelIds must have at most ${DIGEST_MAX_CHANNELS} entries`);
  }
  return body.channelIds.map((id, i) => assertUuid(id, `channelIds[${i}]`));
}

// Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry 6).
// Sources unread mentions plus an explicit set of caller-chosen channels
// (workspaceDigestService.js — see that file for the explicit-list-vs-
// starred-channels scope call) within a bounded time window, then streams
// back a single markdown digest using the same truncate-to-context-window +
// one-completion pattern summarize/extract-tasks already use above, rather
// than true multi-batch hierarchical summarization (documented scope
// reduction, PROJECT_PLAN.md Section 11).
aiRouter.post('/ai/workspace-digest', aiDigestRateLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.body?.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);

    const windowHours = parseDigestWindowHours(req.body ?? {});
    const channelIds = parseDigestChannelIds(req.body ?? {});
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const { messages, mentionCount, channelMessageCount } = await selectDigestMessages(db, {
      userId: req.user.id,
      workspaceId,
      since,
      channelIds,
    });

    if (messages.length === 0) {
      throw new ValidationError('No recent mentions or channel activity found for the requested digest window');
    }

    // Client-disconnect cancellation (design: "allow cancellation without
    // leaving the provider request running indefinitely"). Aborting after
    // the response has already finished normally is a harmless no-op — the
    // upstream fetch has already settled by then.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let result;
    try {
      result = await runStreamingCompletion({
        db,
        res,
        promptBuilder: buildDigestPrompt,
        promptVersionField: 'digestPromptVersion',
        messages,
        signal: controller.signal,
      });
    } catch (err) {
      if (res.headersSent) {
        // eslint-disable-next-line no-console
        console.error('AI workspace digest failed mid-stream:', err);
        res.end();
        return;
      }
      throw err;
    }

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_WORKSPACE_DIGEST_REQUESTED',
      targetResource: workspaceId,
      payload: {
        windowHours,
        channelIds,
        mentionCount,
        channelMessageCount,
        selectedMessageCount: messages.length,
        chunkCount: 1, // v1 always sends one batch — see the doc comment above
        provider: result.provider,
        promptVersion: result.promptVersion,
        truncatedInputLength: result.truncatedInputLength,
        wasTruncated: result.wasTruncated,
      },
    });
  } catch (err) {
    next(err);
  }
});
