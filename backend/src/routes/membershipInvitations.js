import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { assertUuid, parseOffsetPagination } from '../validation.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { markMembershipInvitationNotificationRead } from '../services/userNotificationService.js';
import { NotFoundError, ConflictError } from '../errors.js';

// FEATURE_REQUEST.md "Live notification system + in-app invitation
// notification & acceptance workflow": deliberately distinct from
// invitations.js's token-based invitations, which onboard someone with no
// account yet. This router addresses someone who already has one and is
// already authenticated — the recipient's own session is the credential, no
// token needed. Creation lives on organizations.js/workspaces.js (scoped to
// the same permission gate their existing direct-add routes use); this
// router only ever acts on the caller's own rows.
export const membershipInvitationsRouter = Router();

membershipInvitationsRouter.use(requireAuth);

// GET / — the caller's own pending invitations. No permission gate beyond
// requireAuth: this can only ever return rows addressed to the caller
// (invited_user_id is never client-supplied), so there's nothing to
// existence-hide here the way a workspace/channel lookup would need to.
//
// Finding 3, docs/reviews/security-performance-review-2026-07-20.md: no cap
// existed on how many pending invitations a single account can accumulate —
// offset-paginated like every other roster/list endpoint this pass fixed.
// The frontend's fetchAllPages() helper is the frontend half of this fix
// (api/notifications.js), the same "core list, keep the flat-array
// contract" tradeoff already established for listOrganizations/listChannels.
membershipInvitationsRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = parseOffsetPagination(req.query);

    const baseQuery = () =>
      db('membership_invitations as mi')
        .join('users as u', 'u.id', 'mi.invited_by')
        .leftJoin('organizations as o', 'o.id', 'mi.organization_id')
        .leftJoin('workspaces as w', 'w.id', 'mi.workspace_id')
        .where({ 'mi.invited_user_id': req.user.id, 'mi.status': 'PENDING' });

    const [{ count }, rows] = await Promise.all([
      baseQuery().count('mi.id as count').first(),
      baseQuery()
        .select(
          'mi.id',
          'mi.scope_type',
          'mi.organization_id',
          'mi.workspace_id',
          'mi.invited_role',
          'mi.created_at',
          'u.username as invited_by_username',
          'u.display_name as invited_by_display_name',
          'o.name as organization_name',
          'w.name as workspace_name',
        )
        .orderBy('mi.created_at', 'desc')
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      invitations: rows.map((r) => ({
        id: r.id,
        scopeType: r.scope_type,
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        scopeName: r.scope_type === 'ORGANIZATION' ? r.organization_name : r.workspace_name,
        invitedRole: r.invited_role,
        createdAt: r.created_at,
        invitedByUsername: r.invited_by_username,
        invitedByDisplayName: r.invited_by_display_name,
      })),
      total: Number(count),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

// Row-locked lookup shared by accept/decline. A different user's invitation
// id, or one already resolved, gets the same generic 404 — the same
// existence-hiding instinct as every other membership check in this app,
// applied to a row instead of a workspace/channel.
async function loadOwnPendingInvitationForUpdate(trx, userId, id) {
  const row = await trx('membership_invitations').where({ id }).forUpdate().first();
  if (!row || row.invited_user_id !== userId || row.status !== 'PENDING') {
    throw new NotFoundError('Invitation not found');
  }
  return row;
}

// POST /:id/accept — inserts the offered-role membership and resolves the
// invitation, transactionally. Idempotent-safe against a benign race (the
// user already holds the membership some other way): skips the duplicate
// insert rather than erroring, since the caller's own intent ("I want this
// membership") is already satisfied either way.
//
// Finding 6, docs/reviews/security-performance-review-2026-07-20.md: mirrors
// invitations.js's token-redemption path, which already re-checks
// archived_at inside the same row-locked transaction at *redemption* time,
// not just at invite-creation time (a scope can be archived any time after
// a membership invitation was sent, while it sits PENDING). This path used
// to have no such re-check at all. Unlike the public token-redemption
// route, the caller here is already authenticated and this is their own
// invitation row — nothing to existence-hide — so a real ConflictError,
// not a generic 404, correctly tells them why acceptance failed.
membershipInvitationsRouter.post('/:id/accept', async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'id');

    const row = await db.transaction(async (trx) => {
      const invitation = await loadOwnPendingInvitationForUpdate(trx, req.user.id, id);

      if (invitation.scope_type === 'ORGANIZATION') {
        const org = await trx('organizations').where({ id: invitation.organization_id }).first('archived_at');
        if (!org || org.archived_at) {
          throw new ConflictError('This organization is archived');
        }

        const existing = await trx('organization_members')
          .where({ organization_id: invitation.organization_id, user_id: req.user.id })
          .first();
        if (!existing) {
          await trx('organization_members').insert({
            organization_id: invitation.organization_id,
            user_id: req.user.id,
            org_role: invitation.invited_role,
          });
        }
      } else {
        const workspace = await trx('workspaces').where({ id: invitation.workspace_id }).first('archived_at');
        if (!workspace || workspace.archived_at) {
          throw new ConflictError('This workspace is archived');
        }

        const existing = await trx('workspace_members')
          .where({ workspace_id: invitation.workspace_id, user_id: req.user.id })
          .first();
        if (!existing) {
          await trx('workspace_members').insert({
            workspace_id: invitation.workspace_id,
            user_id: req.user.id,
            system_role: invitation.invited_role,
          });
        }
      }

      await trx('membership_invitations').where({ id }).update({ status: 'ACCEPTED', resolved_at: trx.fn.now() });
      return invitation;
    });

    await markMembershipInvitationNotificationRead(db, req.user.id, id);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: row.scope_type === 'ORGANIZATION' ? 'ORGANIZATION_MEMBERSHIP_CHANGE' : 'WORKSPACE_MEMBERSHIP_CHANGE',
      targetResource: row.scope_type === 'ORGANIZATION' ? row.organization_id : row.workspace_id,
      payload: { action: 'invite_accept', membershipInvitationId: id, role: row.invited_role },
    });

    res.status(200).json({ id, status: 'ACCEPTED', scopeType: row.scope_type });
  } catch (err) {
    next(err);
  }
});

// POST /:id/decline — resolves the invitation with no membership created.
membershipInvitationsRouter.post('/:id/decline', async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'id');

    const row = await db.transaction(async (trx) => {
      const invitation = await loadOwnPendingInvitationForUpdate(trx, req.user.id, id);
      await trx('membership_invitations').where({ id }).update({ status: 'DECLINED', resolved_at: trx.fn.now() });
      return invitation;
    });

    await markMembershipInvitationNotificationRead(db, req.user.id, id);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: row.scope_type === 'ORGANIZATION' ? 'ORGANIZATION_MEMBERSHIP_CHANGE' : 'WORKSPACE_MEMBERSHIP_CHANGE',
      targetResource: row.scope_type === 'ORGANIZATION' ? row.organization_id : row.workspace_id,
      payload: { action: 'invite_decline', membershipInvitationId: id, role: row.invited_role },
    });

    res.status(200).json({ id, status: 'DECLINED', scopeType: row.scope_type });
  } catch (err) {
    next(err);
  }
});
