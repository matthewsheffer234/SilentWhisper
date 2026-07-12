import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember, requireAnyWorkspaceAdmin } from '../authz/membershipService.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertBoundedInt } from '../validation.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { getEffectiveSettings, validateSettingsPatch, updateSettings } from '../llm/settingsService.js';
import { getHealthStatus } from '../llm/healthCheck.js';
import { buildSummaryPrompt, buildTaskExtractionPrompt } from '../llm/promptTemplates.js';
import { runStreamingCompletion } from '../llm/aiService.js';
import { aiProxyRateLimiter } from '../llm/aiRateLimit.js';

export const aiRouter = Router();

aiRouter.use(requireAuth);

// Admin-only per PROJECT_PLAN.md Section 6 ("Admins can inspect the active
// provider..."). "Admin" here means ADMIN in at least one workspace — see
// requireAnyWorkspaceAdmin's doc comment for why, given app_settings has no
// per-workspace scoping of its own.
aiRouter.get('/ai/settings', async (req, res, next) => {
  try {
    await requireAnyWorkspaceAdmin(db, req.user.id);
    const settings = await getEffectiveSettings(db);
    res.json({ ...settings, health: getHealthStatus() });
  } catch (err) {
    next(err);
  }
});

aiRouter.patch('/ai/settings', async (req, res, next) => {
  try {
    await requireAnyWorkspaceAdmin(db, req.user.id);
    const patch = validateSettingsPatch(req.body ?? {});
    const settings = await updateSettings(db, patch, req.user.id);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AI_SETTINGS_UPDATED',
      targetResource: 'app_settings',
      payload: patch,
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
