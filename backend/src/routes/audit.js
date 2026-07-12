import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireAnyWorkspaceAdmin } from '../authz/membershipService.js';
import { appendAuditEvent, verifyAuditChain } from '../audit/auditService.js';
import { assertBoundedInt } from '../validation.js';

export const auditRouter = Router();

auditRouter.use(requireAuth);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// PROJECT_PLAN.md Section 3, Authorization Model: "Private channels, direct
// messages, and group DMs must never be joinable, listable, or readable by
// non-members, including via search or admin tooling. The admin audit
// dashboard is the one intentional exception, and that exception is itself
// an audited action." — every page of the dashboard a caller loads inserts
// its own `AUDIT_DASHBOARD_ACCESSED` row, not just a one-time "dashboard
// opened" event, since each call is a fresh read of potentially sensitive
// metadata (e.g. who was added to a private channel). "Admin" here is the
// same "ADMIN in at least one workspace" gate Phase 4 established for the
// AI settings surface — see requireAnyWorkspaceAdmin's doc comment.
auditRouter.get('/audit/logs', async (req, res, next) => {
  try {
    await requireAnyWorkspaceAdmin(db, req.user.id);

    const limit =
      req.query.limit !== undefined ? assertBoundedInt(req.query.limit, { min: 1, max: MAX_LIMIT }, 'limit') : DEFAULT_LIMIT;

    let query = db('audit_logs').orderBy('id', 'desc').limit(limit);
    let beforeId = null;
    if (req.query.beforeId !== undefined) {
      beforeId = assertBoundedInt(req.query.beforeId, { min: 1, max: Number.MAX_SAFE_INTEGER }, 'beforeId');
      query = query.where('id', '<', beforeId);
    }

    const rows = await query.select(
      'id',
      'timestamp',
      'actor_id',
      'actor_ip',
      'action_type',
      'target_resource',
      'payload',
    );

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AUDIT_DASHBOARD_ACCESSED',
      payload: { limit, beforeId, rowsReturned: rows.length },
    });

    res.json(
      rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        actorId: r.actor_id,
        actorIp: r.actor_ip,
        actionType: r.action_type,
        targetResource: r.target_resource,
        payload: r.payload,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Same recompute-and-compare logic as the standalone /scripts CLI tool
// (verifyAuditChain in auditService.js is the single source of truth for the
// hash math both share) — exposed here so the dashboard can trigger a
// verification without shelling out. Tracked separately from dashboard
// reads as its own audit action type per Section 6 ("Admin audit
// verification attempts").
auditRouter.post('/audit/verify', async (req, res, next) => {
  try {
    await requireAnyWorkspaceAdmin(db, req.user.id);

    const result = await verifyAuditChain(db);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'AUDIT_VERIFICATION_ATTEMPTED',
      payload: { verified: result.verified, rowsChecked: result.rowsChecked, firstFailure: result.firstFailure ?? null },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
