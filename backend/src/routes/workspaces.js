import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertName, assertUsername, assertEmail, assertEnum, CREATABLE_CHANNEL_TYPES, ASSIGNABLE_WORKSPACE_ROLES, WORKSPACE_VISIBILITY } from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { revokeAllRefreshTokensForUser } from '../auth/refreshTokens.js';
import { generateInvitationToken, hashInvitationToken, INVITATION_TOKEN_TTL_MS } from '../auth/invitationTokens.js';
import { adminUserCreateLimiter, adminPasswordResetLimiter, invitationCreateLimiter } from '../auth/rateLimit.js';
import {
  requireWorkspaceMember,
  requireWorkspacePermission,
  requireWorkspaceNotArchived,
  requireChannelMember,
  requireOrgMember,
  getWorkspaceRole,
  getChannel,
  isChannelMember,
} from '../authz/membershipService.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';

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
      const [ws] = await trx('workspaces')
        .insert({ name, owner_id: req.user.id, visibility, organization_id: organizationId })
        .returning(['id', 'name', 'owner_id', 'visibility', 'created_at']);
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

    res.status(201).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.owner_id,
      visibility: workspace.visibility,
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
      .select('w.id', 'w.name', 'w.owner_id', 'w.organization_id', 'w.archived_at', 'wm.system_role')
      .orderBy('w.created_at', 'asc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        ownerId: r.owner_id,
        organizationId: r.organization_id,
        role: r.system_role,
        archivedAt: r.archived_at,
      })),
    );
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

    res.status(200).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.owner_id,
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
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
    await requireWorkspaceNotArchived(db, workspaceId);

    const username = assertUsername(req.body?.username);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';

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
// out-of-band precedent as admin-set passwords.
workspacesRouter.post('/:workspaceId/invitations', invitationCreateLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
    await requireWorkspaceNotArchived(db, workspaceId);

    const email = assertEmail(req.body?.email);
    const invitedRole =
      req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';

    const rawToken = generateInvitationToken();
    const [invitation] = await db('invitations')
      .insert({
        scope_type: 'WORKSPACE',
        workspace_id: workspaceId,
        email,
        invited_role: invitedRole,
        invited_by: req.user.id,
        token_hash: hashInvitationToken(rawToken),
        expires_at: new Date(Date.now() + INVITATION_TOKEN_TTL_MS),
      })
      .returning(['id', 'email', 'invited_role', 'expires_at']);

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'INVITATION_CREATED',
      targetResource: invitation.id,
      payload: { scopeType: 'WORKSPACE', workspaceId, email, invitedRole },
    });

    res.status(201).json({
      id: invitation.id,
      email: invitation.email,
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
      .select('i.id', 'i.email', 'i.invited_role', 'i.expires_at', 'u.username as invited_by_username')
      .orderBy('i.created_at', 'desc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        invitedRole: r.invited_role,
        expiresAt: r.expires_at,
        invitedByUsername: r.invited_by_username,
      })),
    );
  } catch (err) {
    next(err);
  }
});

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
      .select('users.id', 'users.username', 'wm.system_role')
      .orderBy('users.username', 'asc');

    res.json(rows.map((r) => ({ userId: r.id, username: r.username, role: r.system_role })));
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
      throw new ConflictError("Cannot change the workspace owner's role directly; ownership transfer is not yet supported");
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

// Admin-provisioned account creation, distinct from the existing invite
// route above (which only attaches an *existing* user by username) — the
// new account always lands as a member of :workspaceId in the same call,
// mirroring how a workspace admin can otherwise only ever invite people
// into a workspace they administer, rather than opening a broader "any
// admin creates any account" capability with no workspace tie.
workspacesRouter.post('/:workspaceId/users', adminUserCreateLimiter, async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspacePermission(db, req.user.id, workspaceId, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
    await requireWorkspaceNotArchived(db, workspaceId);

    const username = assertUsername(req.body?.username);
    const email = assertEmail(req.body?.email);
    const passwordError = assertValidPassword(req.body?.password);
    if (passwordError) throw new ValidationError(passwordError);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_WORKSPACE_ROLES, 'role') : 'MEMBER';

    const existing = await db('users').where({ username }).orWhere({ email }).first();
    if (existing) {
      // Same generic, non-enumerating message as signup's duplicate check.
      throw new ConflictError('Username or email already in use');
    }

    const passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptSaltRounds);
    const newUser = await db.transaction(async (trx) => {
      const [user] = await trx('users')
        .insert({ username, email, password_hash: passwordHash, display_name: username })
        .returning(['id', 'username', 'email']);
      await trx('workspace_members').insert({ workspace_id: workspaceId, user_id: user.id, system_role: role });
      return user;
    });

    // No tokens issued — the admin is acting on someone else's behalf, not
    // logging them in. The initial password must be communicated
    // out-of-band; this app has no email-delivery infrastructure.
    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'USER_ACCOUNT_CREATED',
      targetResource: newUser.id,
      payload: { newUserId: newUser.id, username: newUser.username, email: newUser.email, workspaceId, role },
    });

    res.status(201).json({ userId: newUser.id, username: newUser.username, email: newUser.email, role });
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

    const rows = await db('channels as c')
      .leftJoin('channel_members as cm', function joinMembership() {
        this.on('cm.channel_id', '=', 'c.id').andOn('cm.user_id', '=', db.raw('?', [req.user.id]));
      })
      .where('c.workspace_id', workspaceId)
      .andWhere((builder) => builder.where('c.type', 'PUBLIC').orWhereNotNull('cm.user_id'))
      .select('c.id', 'c.name', 'c.type', 'c.created_at')
      .select(db.raw('(cm.user_id IS NOT NULL) as "isMember"'))
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

workspacesRouter.post('/:workspaceId/channels/:channelId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const channelId = assertUuid(req.params.channelId, 'channelId');
    const targetUserId = assertUuid(req.body?.userId, 'userId');

    // Caller must already belong to the channel to add someone else to it.
    await requireChannelMember(db, req.user.id, channelId);
    await requireWorkspaceNotArchived(db, workspaceId);
    // Target must already belong to the workspace — this endpoint adds an
    // existing workspace member to a channel, not a stranger to the workspace.
    const targetRole = await db('workspace_members')
      .where({ workspace_id: workspaceId, user_id: targetUserId })
      .first();
    if (!targetRole) {
      throw new ValidationError('Target user is not a member of this workspace');
    }

    const alreadyMember = await isChannelMember(db, targetUserId, channelId);
    if (!alreadyMember) {
      await db('channel_members').insert({ channel_id: channelId, user_id: targetUserId });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channelId,
        payload: { action: 'add', addedUserId: targetUserId },
      });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
