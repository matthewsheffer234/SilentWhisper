import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import {
  assertUuid,
  assertName,
  assertUsername,
  assertEnum,
  assertBoolean,
  assertBoundedInt,
  MAX_USERNAME_LENGTH,
  CREATABLE_CHANNEL_TYPES,
  ASSIGNABLE_WORKSPACE_ROLES,
  WORKSPACE_VISIBILITY,
  parseOffsetPagination,
} from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { revokeAllRefreshTokensForUser } from '../auth/refreshTokens.js';
import { generateInvitationToken, hashInvitationToken, INVITATION_TOKEN_TTL_MS } from '../auth/invitationTokens.js';
import {
  adminPasswordResetLimiter,
  invitationCreateLimiter,
  memberSearchLimiter,
  membershipInvitationCreateLimiter,
} from '../auth/rateLimit.js';
import {
  requireWorkspaceMember,
  requireWorkspacePermission,
  requireWorkspaceNotArchived,
  requireChannelMember,
  requireOrgMember,
  requireOrgNotArchived,
  getWorkspaceRole,
  getChannel,
  isChannelMember,
  isSystemAdminUser,
} from '../authz/membershipService.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { createUserNotification } from '../services/userNotificationService.js';
import { sendToUser } from '../ws/connectionRegistry.js';
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from '../errors.js';

// Resolves which organization a new workspace attaches to, or which one
// GET /discoverable is scoped to (slice 2, FEATURE_REQUEST.md entry 1):
// an explicit organizationId is validated via the caller's membership
// (404, not 403, for a non-member/nonexistent org — same existence-hiding
// convention as everywhere else); when omitted, defaults to the caller's
// sole org membership. Kept local to this file rather than promoted into
// membershipService.js — it's a workspace-route-specific convenience
// ("caller's sole org"), not a general authorization primitive the way
// requireOrgMember is (organizations.js's routes always take an explicit
// :orgId path param and never need this resolution).
async function resolveCallerOrganization(db, userId, requestedOrgId) {
  if (requestedOrgId) {
    await requireOrgMember(db, userId, requestedOrgId);
    return requestedOrgId;
  }

  const memberships = await db('organization_members').where({ user_id: userId }).select('organization_id');
  if (memberships.length === 0) {
    // Should be unreachable post-slice-2 — signup and invitation redemption
    // both now guarantee >=1 organization_members row. Kept as a defensive
    // 400 rather than crashing below, in case an account somehow reached
    // this without one.
    throw new ValidationError('You do not belong to any organization; specify organizationId explicitly');
  }
  if (memberships.length > 1) {
    throw new ValidationError('You belong to more than one organization; specify organizationId explicitly');
  }
  return memberships[0].organization_id;
}

export const workspacesRouter = Router();

workspacesRouter.use(requireAuth);

workspacesRouter.post('/', async (req, res, next) => {
  try {
    const name = assertName(req.body?.name, 'workspace name');
    const visibility =
      req.body?.visibility !== undefined ? assertEnum(req.body.visibility, WORKSPACE_VISIBILITY, 'visibility') : 'PRIVATE';
    const requestedOrgId = req.body?.organizationId !== undefined ? assertUuid(req.body.organizationId, 'organizationId') : null;

    const workspace = await db.transaction(async (trx) => {
      // Org-aware as of slice 2 (FEATURE_REQUEST.md entry 1): defaults to
      // the caller's sole org membership when organizationId is omitted —
      // a no-op until a second organization actually exists, since every
      // account today has exactly one org membership.
      const organizationId = await resolveCallerOrganization(trx, req.user.id, requestedOrgId);
      // System Admin panel: manage organizations and existing users — an
      // archived org shouldn't grow new workspaces. Scoped to this write
      // path only (not resolveCallerOrganization itself, which GET
      // /discoverable also calls — archived stays browsable, only blocked
      // for writes, same convention workspace archiving already follows).
      await requireOrgNotArchived(trx, organizationId);
      const [ws] = await trx('workspaces')
        .insert({ name, owner_id: req.user.id, visibility, organization_id: organizationId })
        .returning(['id', 'name', 'owner_id', 'organization_id', 'visibility', 'managers_can_archive', 'created_at']);
      await trx('workspace_members').insert({
        workspace_id: ws.id,
        user_id: req.user.id,
        system_role: 'OWNER',
      });
      return ws;
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_CREATED',
      targetResource: workspace.id,
    });

    // organizationId must be present in this response, not just GET /'s —
    // WorkspaceSidebar's org-filtered view (FEATURE_REQUEST.md entry 1,
    // slice 3) matches ws.organizationId === selectedOrganizationId; a
    // response missing it left every freshly created workspace silently
    // invisible in the sidebar (filtered out by undefined !== a real org
    // id) until the next full workspace-list refetch — a real, pre-existing
    // bug caught while verifying slice 4's own e2e coverage, fixed here
    // since it blocks that same coverage from passing.
    res.status(201).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.owner_id,
      organizationId: workspace.organization_id,
      visibility: workspace.visibility,
      managersCanArchive: workspace.managers_can_archive,
      role: 'OWNER',
    });
  } catch (err) {
    next(err);
  }
});

// organizationId is optional (slice 3, FEATURE_REQUEST.md entry 1): the base
// join already scopes every row to the caller's own workspace_members rows,
// so filtering by an org the caller has no relationship to just narrows an
// already-authorized result set to nothing — unlike GET /discoverable, no
// membership check is needed on the param since it cannot leak anything.
workspacesRouter.get('/', async (req, res, next) => {
  try {
    const organizationId =
      req.query.organizationId !== undefined ? assertUuid(req.query.organizationId, 'organizationId') : null;

    const rows = await db('workspaces as w')
      .join('workspace_members as wm', function joinMembers() {
        this.on('wm.workspace_id', '=', 'w.id').andOn('wm.user_id', '=', db.raw('?', [req.user.id]));
      })
      .modify((qb) => {
        if (organizationId) qb.where('w.organization_id', organizationId);
      })
      .select(
        'w.id',
        'w.name',
        'w.owner_id',
        'w.organization_id',
        'w.archived_at',
        'w.visibility',
        'w.managers_can_archive',
        'wm.system_role',
      )
      .orderBy('w.created_at', 'asc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        ownerId: r.owner_id,
        organizationId: r.organization_id,
        role: r.system_role,
        archivedAt: r.archived_at,
        visibility: r.visibility,
        managersCanArchive: r.managers_can_archive,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// System-admin oversight (FEATURE_REQUEST.md entry 1, slice 4): every
// workspace regardless of membership, across every organization. Mounted
// ahead of the /:workspaceId routes below (matching how /discoverable is
// already ordered ahead of them) so "admin" is never mistaken for a
// :workspaceId value by assertUuid. Direct isSystemAdminUser gate, not a
// workspace-role-based fallback — same reasoning as organizations.js's
// POST / and admin.js: "see every account/workspace across every
// organization" would be an unintended cross-tenant information-disclosure
// widening if granted to any workspace OWNER/MANAGER (the same class of
// widening Security.md's 2026-07-15 HIGH finding flagged for AI
// settings/audit, which used to have exactly that fallback). Read-only —
// no mutating actions wired to it this slice.
workspacesRouter.get('/admin/all', async (req, res, next) => {
  try {
    if (!(await isSystemAdminUser(db, req.user.id))) {
      throw new ForbiddenError('System admin privileges required');
    }
    const { limit, offset } = parseOffsetPagination(req.query);

    const [{ count }, rows] = await Promise.all([
      db('workspaces').count('id as count').first(),
      db('workspaces as w')
        .join('users as u', 'u.id', 'w.owner_id')
        .join('organizations as o', 'o.id', 'w.organization_id')
        .select(
          'w.id',
          'w.name',
          'w.owner_id',
          'u.username as owner_username',
          'u.display_name as owner_display_name',
          'w.organization_id',
          'o.name as organization_name',
          'w.visibility',
          'w.archived_at',
        )
        .orderBy('w.created_at', 'asc')
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      workspaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        ownerId: r.owner_id,
        ownerUsername: r.owner_username,
        ownerDisplayName: r.owner_display_name,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        visibility: r.visibility,
        archivedAt: r.archived_at,
      })),
      total: Number(count),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

// Self-service workspace subscription (FEATURE_REQUEST.md): DISCOVERABLE
// (renamed from PUBLIC, entry 1's enterprise-authz slice 1), non-archived
// workspaces the caller isn't already a member of, scoped to one
// organization (slice 2 — organizationId optional, same
// resolveCallerOrganization default-to-sole-org logic as POST / above; a
// no-op filter until a second org's workspace actually exists). Excludes
// archived DISCOVERABLE workspaces too, not just at subscribe-time —
// otherwise this list could show a workspace whose own "Subscribe" button
// 409s immediately, a dead-end result "discoverable" shouldn't produce. No
// `role` in the response shape (unlike GET / above) since the caller has
// none yet.
workspacesRouter.get('/discoverable', async (req, res, next) => {
  try {
    const requestedOrgId =
      req.query.organizationId !== undefined ? assertUuid(req.query.organizationId, 'organizationId') : null;
    const organizationId = await resolveCallerOrganization(db, req.user.id, requestedOrgId);

    const rows = await db('workspaces as w')
      .where('w.visibility', 'DISCOVERABLE')
      .whereNull('w.archived_at')
      .where('w.organization_id', organizationId)
      .whereNotExists(function excludeExistingMembers() {
        this.select(1)
          .from('workspace_members as wm')
          .whereRaw('wm.workspace_id = w.id')
          .andWhere('wm.user_id', req.user.id);
      })
      .select('w.id', 'w.name', 'w.owner_id')
      .orderBy('w.created_at', 'asc');

    res.json(rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id })));
  } catch (err) {
    next(err);
  }
});

// Self-service join, authorized only by visibility = 'DISCOVERABLE' —
// mirrors channels/:id/join's "only public channels can be self-joined"
// pattern, one level up. Unlike that endpoint, the caller isn't a workspace
// member yet at all, so full existence-hiding applies: a PRIVATE workspace
// and a made-up UUID must be indistinguishable (404, not 400/403) per
// Section 3's Authorization Model. Idempotent-safe like the archive
// endpoint: calling this again after already subscribed is a no-op, not a
// duplicate row or a second audit event.
workspacesRouter.post('/:workspaceId/subscribe', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');

    const workspace = await db('workspaces').where({ id: workspaceId }).first();
    if (!workspace || workspace.visibility !== 'DISCOVERABLE') {
      throw new NotFoundError('Workspace not found');
    }
    // Existence is already established at this point (a real PUBLIC
    // workspace), so an archived one is a 409 here, not a 404 — the same
    // "resource exists but is unavailable in its current state" convention
    // requireWorkspaceNotArchived already applies elsewhere.
    await requireWorkspaceNotArchived(db, workspaceId);

    const existingRole = await getWorkspaceRole(db, req.user.id, workspaceId);
    if (!existingRole) {
      await db('workspace_members').insert({ workspace_id: workspaceId, user_id: req.user.id, system_role: 'MEMBER' });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
        targetResource: workspaceId,
        payload: { action: 'subscribe' },
      });
    }

    // organizationId/visibility/managersCanArchive included for the same
    // reason POST / includes them (see its own comment): ChatShell's
    // handleSubscribed appends this response directly into the org-filtered
    // workspaces list, which needs the field present to render the newly
    // subscribed workspace at all.
    res.status(200).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.owner_id,
      organizationId: workspace.organization_id,
      visibility: workspace.visibility,
      managersCanArchive: workspace.managers_can_archive,
      role: existingRole ?? 'MEMBER',
      archivedAt: workspace.archived_at,
    });
  } catch (err) {
    next(err);
  }
});

// OWNER or MANAGER (both hold WORKSPACE_ARCHIVE in this slice — see
// permissions.js). No-ops (200, not an error) if already archived, matching
// the existing idempotent-join-style handling elsewhere (channels/:id/join,
// the members invite route).
workspacesRouter.post('/:workspaceId/archive', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_ARCHIVE);
    const workspace = await db('workspaces').where({ id: workspaceId }).first();

    if (!workspace.archived_at) {
      await db('workspaces').where({ id: workspaceId }).update({ archived_at: new Date(), archived_by: req.user.id });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'WORKSPACE_ARCHIVE_STATUS_CHANGE',
        targetResource: workspaceId,
        payload: { action: 'archive' },
      });
    }

    res.status(200).json({ id: workspaceId, archivedAt: workspace.archived_at ?? new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// Same WORKSPACE_ARCHIVE gate as archive above. Previously narrower
// (ADMIN-role-only, excluding an owner who wasn't separately an ADMIN
// member) — migration 0012 guarantees every owner now holds OWNER, which
// holds WORKSPACE_ARCHIVE, closing that inconsistency (see
// requireWorkspacePermission's doc comment in membershipService.js).
workspacesRouter.post('/:workspaceId/unarchive', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_ARCHIVE);

    const workspace = await db('workspaces').where({ id: workspaceId }).first('archived_at');
    if (workspace.archived_at) {
      await db('workspaces').where({ id: workspaceId }).update({ archived_at: null, archived_by: null });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'WORKSPACE_ARCHIVE_STATUS_CHANGE',
        targetResource: workspaceId,
        payload: { action: 'unarchive' },
      });
    }

    res.status(200).json({ id: workspaceId, archivedAt: null });
  } catch (err) {
    next(err);
  }
});

// Admin-only invite (Section 3, Authorization Model): workspace membership
// is the broader, more consequential grant — implicit visibility into every
// PUBLIC channel in the workspace — so it's gated tighter than adding an
// already-workspace-member to one specific channel below, which any channel
// member can do. Takes a username, not a userId, unlike the channel-members
// endpoint: this is the one membership-write route with an actual frontend
// form behind it (WorkspaceSidebar's "Invite" control), and a human typing
// into that form knows a username, not a UUID.
workspacesRouter.post('/:workspaceId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const username = assertUsername(req.body?.username);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';
    // MANAGER-tier split (FEATURE_REQUEST.md entry 1, slice 4): role must be
    // parsed before this check, since which permission is required depends
    // on it — granting a MANAGER-tier membership needs
    // WORKSPACE_MANAGE_MANAGERS; a plain MEMBER only needs
    // WORKSPACE_MANAGE_MEMBERS. Non-member callers still 404 (requireWorkspacePermission's
    // own existence-hiding), under-privileged members still 403, regardless
    // of which specific permission was needed.
    await requireWorkspacePermission(
      db,
      req.user.id,
      workspaceId,
      role === 'MANAGER' ? PERMISSIONS.WORKSPACE_MANAGE_MANAGERS : PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
    );
    await requireWorkspaceNotArchived(db, workspaceId);

    const targetUser = await db('users').where({ username }).first('id', 'username');
    if (!targetUser) {
      // ValidationError (400), matching the existing channel-members
      // endpoint's "target user issue" convention below — this is a problem
      // with the request body's content, not with :workspaceId itself.
      throw new ValidationError('No user with that username exists');
    }

    const existingRole = await getWorkspaceRole(db, targetUser.id, workspaceId);
    if (existingRole) {
      throw new ConflictError('User is already a member of this workspace');
    }

    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: targetUser.id, system_role: role });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
      targetResource: workspaceId,
      payload: { action: 'add', addedUserId: targetUser.id, addedUsername: targetUser.username, role },
    });

    res.status(201).json({ userId: targetUser.id, username: targetUser.username, role });
  } catch (err) {
    next(err);
  }
});

// Invitations (slice 2, FEATURE_REQUEST.md entry 1): for people who don't
// have an account yet — the invite-by-username route above stays the path
// for adding an *existing* user. Gated on WORKSPACE_MANAGE_MEMBERS, not a
// separate WORKSPACE_INVITE permission (see permissions.js's comment).
// Raw token returned once — no email infra exists in this project, same
// out-of-band precedent as admin-set passwords. The invitee supplies their
// own email at redemption time (invitations.js's POST /:token/accept), not
// here — FEATURE_REQUEST.md's "Remove email-based invitations" entry.
workspacesRouter.post('/:workspaceId/invitations', invitationCreateLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const invitedRole =
      req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';
    // Same MANAGER-tier split as POST /:workspaceId/members above — an
    // invitation that will land as MANAGER on acceptance requires
    // WORKSPACE_MANAGE_MANAGERS up front.
    await requireWorkspacePermission(
      db,
      req.user.id,
      workspaceId,
      invitedRole === 'MANAGER' ? PERMISSIONS.WORKSPACE_MANAGE_MANAGERS : PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
    );
    await requireWorkspaceNotArchived(db, workspaceId);

    const rawToken = generateInvitationToken();
    const [invitation] = await db('invitations')
      .insert({
        scope_type: 'WORKSPACE',
        workspace_id: workspaceId,
        invited_role: invitedRole,
        invited_by: req.user.id,
        token_hash: hashInvitationToken(rawToken),
        expires_at: new Date(Date.now() + INVITATION_TOKEN_TTL_MS),
      })
      .returning(['id', 'invited_role', 'expires_at']);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'INVITATION_CREATED',
      targetResource: invitation.id,
      payload: { scopeType: 'WORKSPACE', workspaceId, invitedRole },
    });

    res.status(201).json({
      id: invitation.id,
      role: invitation.invited_role,
      expiresAt: invitation.expires_at,
      token: rawToken,
    });
  } catch (err) {
    next(err);
  }
});

// Pending-invitations roster (slice 3): the only invitation data the
// frontend would otherwise see is the single just-created token, held in
// transient component state — gone on reload. Same permission gate as the
// POST above; PENDING + not-yet-expired only (ACCEPTED/REVOKED/expired
// invitations aren't actionable from here).
workspacesRouter.get('/:workspaceId/invitations', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);

    const rows = await db('invitations as i')
      .join('users as u', 'u.id', 'i.invited_by')
      .where({ 'i.scope_type': 'WORKSPACE', 'i.workspace_id': workspaceId, 'i.status': 'PENDING' })
      .andWhere('i.expires_at', '>', new Date())
      .select(
        'i.id',
        'i.invited_role',
        'i.expires_at',
        'u.username as invited_by_username',
        'u.display_name as invited_by_display_name',
      )
      .orderBy('i.created_at', 'desc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        invitedRole: r.invited_role,
        expiresAt: r.expires_at,
        invitedByUsername: r.invited_by_username,
        invitedByDisplayName: r.invited_by_display_name,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md "Live notification system + in-app invitation
// notification & acceptance workflow": for an *existing* account — proposes
// membership rather than adding it immediately (POST /:workspaceId/members
// above), notified live, accepted/declined by the recipient via
// /api/membership-invitations. Same MANAGER-tier permission split as the
// immediate-add route and the token-invitation route above.
workspacesRouter.post(
  '/:workspaceId/membership-invitations',
  membershipInvitationCreateLimiter,
  async (req, res, next) => {
    try {
      const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
      const invitedUserId = assertUuid(req.body?.userId, 'userId');
      const role =
        req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';
      await requireWorkspacePermission(
        db,
        req.user.id,
        workspaceId,
        role === 'MANAGER' ? PERMISSIONS.WORKSPACE_MANAGE_MANAGERS : PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
      );
      await requireWorkspaceNotArchived(db, workspaceId);

      const targetUser = await db('users').where({ id: invitedUserId }).first('id', 'username', 'display_name');
      if (!targetUser) {
        throw new ValidationError('No user with that id exists');
      }

      const existingRole = await getWorkspaceRole(db, invitedUserId, workspaceId);
      if (existingRole) {
        throw new ConflictError('User is already a member of this workspace');
      }

      const existingInvitation = await db('membership_invitations')
        .where({ scope_type: 'WORKSPACE', workspace_id: workspaceId, invited_user_id: invitedUserId, status: 'PENDING' })
        .first('id');
      if (existingInvitation) {
        throw new ConflictError('An invitation is already pending for this user');
      }

      const workspace = await db('workspaces').where({ id: workspaceId }).first('name');

      const [invitation] = await db('membership_invitations')
        .insert({
          scope_type: 'WORKSPACE',
          workspace_id: workspaceId,
          invited_user_id: invitedUserId,
          invited_role: role,
          invited_by: req.user.id,
        })
        .returning(['id', 'invited_role', 'created_at']);

      const notification = await createUserNotification(db, {
        recipientUserId: invitedUserId,
        type: 'WORKSPACE_INVITE',
        payload: {
          membershipInvitationId: invitation.id,
          scopeType: 'WORKSPACE',
          workspaceId,
          scopeName: workspace.name,
          invitedRole: role,
          inviterUsername: req.user.username,
          inviterDisplayName: req.user.displayName,
        },
      });

      sendToUser(invitedUserId, {
        type: 'membership_invitation',
        membershipInvitationId: invitation.id,
        scopeType: 'WORKSPACE',
        workspaceId,
        scopeName: workspace.name,
        invitedRole: role,
        inviterUsername: req.user.username,
        inviterDisplayName: req.user.displayName,
        notificationId: notification.id,
      });

      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
        targetResource: workspaceId,
        payload: { action: 'invite', invitedUserId, invitedUsername: targetUser.username, role },
      });

      res.status(201).json({
        id: invitation.id,
        invitedUserId,
        invitedUsername: targetUser.username,
        role,
        status: 'PENDING',
      });
    } catch (err) {
      next(err);
    }
  },
);

// Admin dashboard (FEATURE_REQUEST.md): the roster the "Manage Users" panel
// needs to render — a gap the original design didn't spell out explicitly
// (it specified role-assignment/create/reset-password but not how the
// panel would learn who's already in the workspace), found while
// implementing. Gated on WORKSPACE_MANAGE_MEMBERS, same as the three
// mutating actions below, rather than requireWorkspaceMember — this stays a tightly
// admin-dashboard-scoped roster, not a general "list my workspace's
// members" endpoint any member could call.
workspacesRouter.get('/:workspaceId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);

    const rows = await db('workspace_members as wm')
      .join('users', 'users.id', 'wm.user_id')
      .where('wm.workspace_id', workspaceId)
      .select('users.id', 'users.username', 'users.display_name', 'wm.system_role')
      .orderBy('users.username', 'asc');

    res.json(
      rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, role: r.system_role })),
    );
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md's "unified people picker" entry. Candidate pool is
// every existing user account, system-wide — matches POST /:workspaceId/members's
// own lookup exactly (any existing account, not org-restricted), so a
// picker built on this endpoint can never suggest someone the add endpoint
// would then reject. Gated the same as that same add endpoint
// (WORKSPACE_MANAGE_MEMBERS) rather than plain membership, since this reveals
// matching accounts by email — a broader disclosure than the roster/
// members-search endpoint below, which only ever returns people already in
// the workspace.
workspacesRouter.get('/:workspaceId/people-search', memberSearchLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);

    const limit =
      req.query.limit !== undefined ? assertBoundedInt(req.query.limit, { min: 1, max: 20 }, 'limit') : 8;
    let q = '';
    if (req.query.q !== undefined) {
      q = String(req.query.q);
      if (q.length > MAX_USERNAME_LENGTH) {
        throw new ValidationError(`q must be at most ${MAX_USERNAME_LENGTH} characters`);
      }
    }

    let query = db('users').leftJoin('workspace_members as wm', function joinMembership() {
      this.on('wm.user_id', '=', 'users.id').andOnVal('wm.workspace_id', '=', workspaceId);
    });
    if (q) {
      query = query.andWhere((builder) => {
        builder
          .orWhere('users.username', 'ilike', `${q}%`)
          .orWhere('users.display_name', 'ilike', `${q}%`)
          .orWhere('users.email', 'ilike', `${q}%`);
      });
    }

    const rows = await query
      .orderBy('users.username', 'asc')
      .limit(limit)
      .select('users.id', 'users.username', 'users.display_name', 'users.email', 'wm.user_id as memberUserId');

    res.json(
      rows.map((r) => ({
        userId: r.id,
        username: r.username,
        displayName: r.display_name,
        email: r.email,
        alreadyMember: r.memberUserId != null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Candidate pool is the *current* workspace roster, not every account —
// backs both the private-channel "add people" flow (POST
// /:workspaceId/channels/:channelId/members already requires the target be
// an existing workspace member) and ownership transfer (POST
// /:workspaceId/transfer-ownership, same requirement). Gated on plain
// requireWorkspaceMember, deliberately looser than the people-search
// endpoint above — every field returned here (id/username/displayName) is
// already visible to any workspace-mate through message authorship and
// mentions, so this isn't a new disclosure, and both call sites it backs
// are reachable by a plain member (private-channel invite) or the owner
// (transfer), not just a workspace admin. Passing `channelId` additionally
// requires the caller be a member of that specific channel (matching the
// add-to-channel endpoint's own gate) and flags `alreadyInChannel` per row.
workspacesRouter.get('/:workspaceId/members-search', memberSearchLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);

    let channelId = null;
    if (req.query.channelId !== undefined) {
      channelId = assertUuid(req.query.channelId, 'channelId');
      const channel = await requireChannelMember(db, req.user.id, channelId);
      if (channel.workspace_id !== workspaceId) {
        throw new ValidationError('Channel does not belong to this workspace');
      }
    }

    const limit =
      req.query.limit !== undefined ? assertBoundedInt(req.query.limit, { min: 1, max: 20 }, 'limit') : 8;
    let q = '';
    if (req.query.q !== undefined) {
      q = String(req.query.q);
      if (q.length > MAX_USERNAME_LENGTH) {
        throw new ValidationError(`q must be at most ${MAX_USERNAME_LENGTH} characters`);
      }
    }

    let query = db('workspace_members as wm')
      .join('users', 'users.id', 'wm.user_id')
      .where('wm.workspace_id', workspaceId);
    if (channelId) {
      query = query.leftJoin('channel_members as cm', function joinChannelMembership() {
        this.on('cm.user_id', '=', 'users.id').andOnVal('cm.channel_id', '=', channelId);
      });
    }
    if (q) {
      query = query.andWhere((builder) => {
        builder
          .orWhere('users.username', 'ilike', `${q}%`)
          .orWhere('users.display_name', 'ilike', `${q}%`)
          .orWhere('users.email', 'ilike', `${q}%`);
      });
    }

    const selectCols = ['users.id', 'users.username', 'users.display_name', 'users.email'];
    if (channelId) selectCols.push('cm.user_id as channelMemberUserId');
    const rows = await query.orderBy('users.username', 'asc').limit(limit).select(selectCols);

    res.json(
      rows.map((r) => ({
        userId: r.id,
        username: r.username,
        displayName: r.display_name,
        email: r.email,
        isSelf: r.id === req.user.id,
        ...(channelId ? { alreadyInChannel: r.channelMemberUserId != null } : {}),
      })),
    );
  } catch (err) {
    next(err);
  }
});

// The missing half of the invite flow above, which only sets a role at
// insert time — this changes an *existing* member's role.
workspacesRouter.patch('/:workspaceId/members/:userId', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const targetUserId = assertUuid(req.params.userId, 'userId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
    // Role assignment mutates workspace_members, the same class of write
    // the design's gate list already covers for the invite endpoint above —
    // extended here to the admin dashboard's newer write endpoints too
    // (added after this design was originally written), since "an archived
    // workspace cannot be updated" applies equally to them.
    await requireWorkspaceNotArchived(db, workspaceId);

    const role = assertEnum(req.body?.role, ASSIGNABLE_WORKSPACE_ROLES, 'role');

    const targetRow = await db('workspace_members as wm')
      .join('users', 'users.id', 'wm.user_id')
      .where({ 'wm.workspace_id': workspaceId, 'wm.user_id': targetUserId })
      .first('users.username', 'wm.system_role');
    if (!targetRow) {
      // Existence-hiding, same as every other membership-scoped route —
      // the caller is already an admin of this workspace, but that doesn't
      // establish the *target* exists as a member of it.
      throw new NotFoundError('Workspace member not found');
    }

    // OWNER is structurally unique per workspace (migration 0012 guarantees
    // exactly one) and never directly reassignable through this endpoint —
    // ASSIGNABLE_WORKSPACE_ROLES already rejects 'OWNER' as an input value,
    // so "is this the workspace's only owner" collapses to "is this the
    // owner." No count query needed; ownership transfer is a later slice.
    if (targetRow.system_role === 'OWNER') {
      throw new ConflictError(
        "Cannot change the workspace owner's role directly; use POST /:workspaceId/transfer-ownership to change ownership",
      );
    }

    // MANAGER-tier split (FEATURE_REQUEST.md entry 1, slice 4): the router's
    // top-of-function requireWorkspacePermission call above already
    // establishes WORKSPACE_MANAGE_MEMBERS as the floor. Promoting to
    // MANAGER, or demoting an existing MANAGER, additionally requires
    // WORKSPACE_MANAGE_MANAGERS.
    if (targetRow.system_role === 'MANAGER' || role === 'MANAGER') {
      await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MANAGERS);
    }

    await db('workspace_members')
      .where({ workspace_id: workspaceId, user_id: targetUserId })
      .update({ system_role: role });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
      targetResource: workspaceId,
      payload: {
        action: 'role_change',
        targetUserId,
        targetUsername: targetRow.username,
        fromRole: targetRow.system_role,
        toRole: role,
      },
    });

    res.json({ userId: targetUserId, username: targetRow.username, role });
  } catch (err) {
    next(err);
  }
});

// New (FEATURE_REQUEST.md entry 1, slice 4): removes a member entirely,
// cascading to their channel_members rows in this workspace — the previous
// slices had no DELETE at all. Retiring POST /:workspaceId/users (the
// account-provisioning route immediately above in prior slices) means this
// is now the only membership-write route not already covered by the
// invite/role-change endpoints above.
workspacesRouter.delete('/:workspaceId/members/:userId', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const targetUserId = assertUuid(req.params.userId, 'userId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
    await requireWorkspaceNotArchived(db, workspaceId);

    const targetRow = await db('workspace_members as wm')
      .join('users', 'users.id', 'wm.user_id')
      .where({ 'wm.workspace_id': workspaceId, 'wm.user_id': targetUserId })
      .first('users.username', 'wm.system_role');
    if (!targetRow) {
      throw new NotFoundError('Workspace member not found');
    }

    if (targetRow.system_role === 'OWNER') {
      throw new ConflictError('Cannot remove the workspace owner; transfer ownership first');
    }

    // Same MANAGER-tier split as the PATCH route above.
    if (targetRow.system_role === 'MANAGER') {
      await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MANAGERS);
    }

    await db.transaction(async (trx) => {
      await trx('channel_members')
        .where({ user_id: targetUserId })
        .whereIn('channel_id', trx('channels').select('id').where({ workspace_id: workspaceId }))
        .del();
      await trx('workspace_members').where({ workspace_id: workspaceId, user_id: targetUserId }).del();
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
      targetResource: workspaceId,
      payload: { action: 'remove', targetUserId, targetUsername: targetRow.username },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// New (FEATURE_REQUEST.md entry 1, slice 4): OWNER only. Takes a username,
// not a userId — mirrors POST /:workspaceId/members's own precedent/comment
// ("a human typing into that form knows a username, not a UUID"), and avoids
// the frontend needing a separate roster fetch just to resolve a username
// before submitting the sidebar's inline form.
workspacesRouter.post('/:workspaceId/transfer-ownership', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP);
    await requireWorkspaceNotArchived(db, workspaceId);

    const username = assertUsername(req.body?.username);
    const targetUser = await db('users').where({ username }).first('id', 'username');
    if (!targetUser) {
      throw new ValidationError('No user with that username exists');
    }
    const targetRole = await getWorkspaceRole(db, targetUser.id, workspaceId);
    if (!targetRole) {
      throw new ValidationError('Target user is not a member of this workspace');
    }
    if (targetUser.id === req.user.id) {
      throw new ValidationError('Cannot transfer ownership to yourself');
    }

    await db.transaction(async (trx) => {
      await trx('workspace_members')
        .where({ workspace_id: workspaceId, user_id: req.user.id })
        .update({ system_role: 'MANAGER' });
      await trx('workspace_members')
        .where({ workspace_id: workspaceId, user_id: targetUser.id })
        .update({ system_role: 'OWNER' });
      await trx('workspaces').where({ id: workspaceId }).update({ owner_id: targetUser.id });
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_OWNERSHIP_TRANSFERRED',
      targetResource: workspaceId,
      payload: { fromUserId: req.user.id, toUserId: targetUser.id, toUsername: targetUser.username },
    });

    res.status(200).json({ id: workspaceId, ownerId: targetUser.id });
  } catch (err) {
    next(err);
  }
});

// New (FEATURE_REQUEST.md entry 1, slice 4): OWNER only, idempotent-safe —
// same convention as archive/unarchive/subscribe (a no-op skips both the
// write and the audit event rather than producing a duplicate no-change
// row).
workspacesRouter.post('/:workspaceId/visibility', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY);
    await requireWorkspaceNotArchived(db, workspaceId);

    const visibility = assertEnum(req.body?.visibility, WORKSPACE_VISIBILITY, 'visibility');
    const workspace = await db('workspaces').where({ id: workspaceId }).first('visibility');

    if (workspace.visibility !== visibility) {
      await db('workspaces').where({ id: workspaceId }).update({ visibility });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'WORKSPACE_VISIBILITY_CHANGED',
        targetResource: workspaceId,
        payload: { fromVisibility: workspace.visibility, toVisibility: visibility },
      });
    }

    res.status(200).json({ id: workspaceId, visibility });
  } catch (err) {
    next(err);
  }
});

// New (FEATURE_REQUEST.md entry 1, slice 4, gap-fill — SLICE_4_PLAN.md
// decision 6): managers_can_archive has existed in the schema since
// migration 0011 but had no setter anywhere in the codebase until now.
// OWNER only. Deliberately *not* gated by requireWorkspaceNotArchived —
// an archived workspace's owner should still be able to pre-configure
// delegation before unarchiving. Not audited: matches this codebase's
// existing precedent that not every state change gets a bespoke audit row
// (e.g. AUTH_TOKEN_REFRESH records only the actor) — a deliberate,
// scope-minimizing choice, trivially reversible later.
workspacesRouter.post('/:workspaceId/settings', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_SETTINGS);

    const managersCanArchive = assertBoolean(req.body?.managersCanArchive, 'managersCanArchive');
    await db('workspaces').where({ id: workspaceId }).update({ managers_can_archive: managersCanArchive });

    res.status(200).json({ id: workspaceId, managersCanArchive });
  } catch (err) {
    next(err);
  }
});

// Admin-initiated password reset for another member of a workspace this
// admin administers — distinct from POST /api/auth/change-password (the
// self-service flow), which requires knowing the current password and
// preserves the caller's own session. This has neither property: it's a
// different person's credential, so the target is fully logged out
// everywhere instead.
workspacesRouter.post('/:workspaceId/members/:userId/reset-password', adminPasswordResetLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const targetUserId = assertUuid(req.params.userId, 'userId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);

    const targetRow = await db('workspace_members as wm')
      .join('users', 'users.id', 'wm.user_id')
      .where({ 'wm.workspace_id': workspaceId, 'wm.user_id': targetUserId })
      .first('users.username');
    if (!targetRow) {
      throw new NotFoundError('Workspace member not found');
    }

    if (targetUserId === req.user.id) {
      // Never two divergent code paths for changing one's own password.
      throw new ValidationError('Use POST /api/auth/change-password to change your own password');
    }

    const passwordError = assertValidPassword(req.body?.newPassword);
    if (passwordError) throw new ValidationError(passwordError);

    const passwordHash = await bcrypt.hash(req.body.newPassword, config.auth.bcryptSaltRounds);
    await db('users').where({ id: targetUserId }).update({ password_hash: passwordHash });
    await revokeAllRefreshTokensForUser(db, targetUserId);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ADMIN_PASSWORD_RESET',
      targetResource: targetUserId,
      payload: { targetUserId, targetUsername: targetRow.username, workspaceId },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

workspacesRouter.post('/:workspaceId/channels', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceNotArchived(db, workspaceId);

    const name = assertName(req.body?.name, 'channel name');
    const type = assertEnum(req.body?.type, CREATABLE_CHANNEL_TYPES, 'type');

    const channel = await db.transaction(async (trx) => {
      const [ch] = await trx('channels')
        .insert({ workspace_id: workspaceId, name, type })
        .returning(['id', 'workspace_id', 'name', 'type', 'created_at']);
      await trx('channel_members').insert({ channel_id: ch.id, user_id: req.user.id });
      return ch;
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'CHANNEL_CREATED',
      targetResource: channel.id,
      payload: { workspaceId, type },
    });

    res.status(201).json({ id: channel.id, workspaceId: channel.workspace_id, name: channel.name, type: channel.type });
  } catch (err) {
    next(err);
  }
});

// Visible channels: every PUBLIC channel in the workspace (joinable, so
// listable even before joining) plus PRIVATE channels the user already
// belongs to. Never lists a PRIVATE channel the user isn't a member of
// (Section 3, Authorization Model).
workspacesRouter.get('/:workspaceId/channels', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);

    // FEATURE_REQUEST.md's "channel details panel" entry: the channel
    // header shows member count without a separate fetch, so it's a
    // correlated subquery here rather than a second LEFT JOIN — that would
    // multiply rows (one per member) and require an extra GROUP BY across
    // every other already-selected column.
    const rows = await db('channels as c')
      .leftJoin('channel_members as cm', function joinMembership() {
        this.on('cm.channel_id', '=', 'c.id').andOn('cm.user_id', '=', db.raw('?', [req.user.id]));
      })
      .where('c.workspace_id', workspaceId)
      .andWhere((builder) => builder.where('c.type', 'PUBLIC').orWhereNotNull('cm.user_id'))
      .select('c.id', 'c.name', 'c.type', 'c.created_at')
      .select(db.raw('(cm.user_id IS NOT NULL) as "isMember"'))
      .select(
        db.raw(
          '(SELECT COUNT(*) FROM channel_members WHERE channel_members.channel_id = c.id)::int as "memberCount"',
        ),
      )
      .orderBy('c.created_at', 'asc');

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

workspacesRouter.post('/:workspaceId/channels/:channelId/join', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    await requireWorkspaceNotArchived(db, workspaceId);

    const channel = await getChannel(db, channelId);
    if (!channel || channel.workspace_id !== workspaceId) {
      throw new ValidationError('Channel not found in this workspace');
    }
    if (channel.type !== 'PUBLIC') {
      throw new ValidationError('Only public channels can be self-joined; ask an existing member to add you');
    }

    const alreadyMember = await isChannelMember(db, req.user.id, channelId);
    if (!alreadyMember) {
      await db('channel_members').insert({ channel_id: channelId, user_id: req.user.id });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channelId,
        payload: { action: 'join' },
      });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md's "channel details panel" entry: the full member
// roster for the panel's own member list — deliberately not the
// GET /channels/:channelId/members mention-autocomplete endpoint
// (messages.js), which is search-driven and capped at 8 results by design.
// This one is a plain, uncapped listing, gated the same as adding a member
// (requireChannelMember) since seeing the full roster is no more sensitive
// than being able to grow it.
workspacesRouter.get('/:workspaceId/channels/:channelId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const channelId = assertUuid(req.params.channelId, 'channelId');
    const channel = await requireChannelMember(db, req.user.id, channelId);
    if (channel.workspace_id !== workspaceId) {
      throw new ValidationError('Channel not found in this workspace');
    }

    const rows = await db('channel_members as cm')
      .join('users', 'users.id', 'cm.user_id')
      .where('cm.channel_id', channelId)
      .select('users.id', 'users.username', 'users.display_name')
      .orderBy('users.username', 'asc');

    res.json(rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name })));
  } catch (err) {
    next(err);
  }
});

workspacesRouter.post('/:workspaceId/channels/:channelId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const channelId = assertUuid(req.params.channelId, 'channelId');
    // Username, not userId — matches every other "invite by typing a name"
    // route in this file (POST /:workspaceId/members, transfer-ownership).
    // A member typing an invite into the new channel-invite UI knows a
    // username, not a UUID.
    const username = assertUsername(req.body?.username);

    // Caller must already belong to the channel to add someone else to it.
    const channel = await requireChannelMember(db, req.user.id, channelId);
    // Bind the path parameters together before any target-membership check
    // (Security.md, 2026-07-15, HIGH: "Cross-Workspace Channel Membership
    // Injection") — without this, a caller could pass an unrelated
    // workspaceId where their *other* account holds membership, and that
    // account's workspace-B membership would satisfy the target-membership
    // check below for a channel that actually belongs to workspace A,
    // granting access to a private channel without ever joining its real
    // workspace. Same check the sibling GET .../members roster route above
    // already makes.
    if (channel.workspace_id !== workspaceId) {
      throw new ValidationError('Channel not found in this workspace');
    }
    await requireWorkspaceNotArchived(db, channel.workspace_id);

    const targetUser = await db('users').where({ username }).first('id', 'username');
    if (!targetUser) {
      throw new ValidationError('No user with that username exists');
    }

    // Target must already belong to the *channel's actual* workspace — this
    // endpoint adds an existing workspace member to a channel, not a
    // stranger to the workspace. Uses channel.workspace_id, not the path
    // parameter, now that the two are confirmed equal above; kept explicit
    // rather than reusing workspaceId so a future edit can't silently
    // reintroduce the same binding gap.
    const targetRole = await db('workspace_members')
      .where({ workspace_id: channel.workspace_id, user_id: targetUser.id })
      .first();
    if (!targetRole) {
      throw new ValidationError('Target user is not a member of this workspace');
    }

    const alreadyMember = await isChannelMember(db, targetUser.id, channelId);
    if (!alreadyMember) {
      await db('channel_members').insert({ channel_id: channelId, user_id: targetUser.id });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channelId,
        payload: { action: 'add', addedUserId: targetUser.id, addedUsername: targetUser.username },
      });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
