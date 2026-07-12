import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertName, assertUsername, assertEmail, assertEnum, CREATABLE_CHANNEL_TYPES, WORKSPACE_ROLES } from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { revokeAllRefreshTokensForUser } from '../auth/refreshTokens.js';
import { adminUserCreateLimiter, adminPasswordResetLimiter } from '../auth/rateLimit.js';
import {
  requireWorkspaceMember,
  requireWorkspaceAdmin,
  requireWorkspaceOwnerOrAdmin,
  requireWorkspaceNotArchived,
  requireChannelMember,
  getWorkspaceRole,
  getChannel,
  isChannelMember,
} from '../authz/membershipService.js';
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';

export const workspacesRouter = Router();

workspacesRouter.use(requireAuth);

workspacesRouter.post('/', async (req, res, next) => {
  try {
    const name = assertName(req.body?.name, 'workspace name');

    const workspace = await db.transaction(async (trx) => {
      const [ws] = await trx('workspaces')
        .insert({ name, owner_id: req.user.id })
        .returning(['id', 'name', 'owner_id', 'created_at']);
      await trx('workspace_members').insert({
        workspace_id: ws.id,
        user_id: req.user.id,
        system_role: 'ADMIN',
      });
      return ws;
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'WORKSPACE_CREATED',
      targetResource: workspace.id,
    });

    res.status(201).json({ id: workspace.id, name: workspace.name, ownerId: workspace.owner_id, role: 'ADMIN' });
  } catch (err) {
    next(err);
  }
});

workspacesRouter.get('/', async (req, res, next) => {
  try {
    const rows = await db('workspaces as w')
      .join('workspace_members as wm', function joinMembers() {
        this.on('wm.workspace_id', '=', 'w.id').andOn('wm.user_id', '=', db.raw('?', [req.user.id]));
      })
      .select('w.id', 'w.name', 'w.owner_id', 'w.archived_at', 'wm.system_role')
      .orderBy('w.created_at', 'asc');

    res.json(
      rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, role: r.system_role, archivedAt: r.archived_at })),
    );
  } catch (err) {
    next(err);
  }
});

// Owner-or-admin (per the request: "owners and admins" can archive) —
// broader than requireWorkspaceAdmin alone. No-ops (200, not an error) if
// already archived, matching the existing idempotent-join-style handling
// elsewhere (channels/:id/join, the members invite route).
workspacesRouter.post('/:workspaceId/archive', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    const workspace = await requireWorkspaceOwnerOrAdmin(db, req.user.id, workspaceId);

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

// Admin-only (deliberately narrower than archive's owner-or-admin gate, per
// the request's explicit distinction: "admins should also be able to
// un-archive").
workspacesRouter.post('/:workspaceId/unarchive', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);

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
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);
    await requireWorkspaceNotArchived(db, workspaceId);

    const username = assertUsername(req.body?.username);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, WORKSPACE_ROLES, 'role') : 'MEMBER';

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

// Admin dashboard (FEATURE_REQUEST.md): the roster the "Manage Users" panel
// needs to render — a gap the original design didn't spell out explicitly
// (it specified role-assignment/create/reset-password but not how the
// panel would learn who's already in the workspace), found while
// implementing. Gated on requireWorkspaceAdmin, same as the three mutating
// actions below, rather than requireWorkspaceMember — this stays a tightly
// admin-dashboard-scoped roster, not a general "list my workspace's
// members" endpoint any member could call.
workspacesRouter.get('/:workspaceId/members', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);

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
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);
    // Role assignment mutates workspace_members, the same class of write
    // the design's gate list already covers for the invite endpoint above —
    // extended here to the admin dashboard's newer write endpoints too
    // (added after this design was originally written), since "an archived
    // workspace cannot be updated" applies equally to them.
    await requireWorkspaceNotArchived(db, workspaceId);

    const role = assertEnum(req.body?.role, WORKSPACE_ROLES, 'role');

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

    if (targetRow.system_role === 'ADMIN' && role === 'MEMBER') {
      const adminCount = await db('workspace_members')
        .where({ workspace_id: workspaceId, system_role: 'ADMIN' })
        .count('* as count')
        .first();
      if (Number(adminCount.count) <= 1) {
        // Without this, a single careless self-demotion (or the only other
        // admin demoting the last one) permanently locks the workspace out
        // of every admin-gated action — including this dashboard itself —
        // with no recovery path short of a raw DB write.
        throw new ConflictError("Cannot remove the workspace's last admin");
      }
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
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);
    await requireWorkspaceNotArchived(db, workspaceId);

    const username = assertUsername(req.body?.username);
    const email = assertEmail(req.body?.email);
    const passwordError = assertValidPassword(req.body?.password);
    if (passwordError) throw new ValidationError(passwordError);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, WORKSPACE_ROLES, 'role') : 'MEMBER';

    const existing = await db('users').where({ username }).orWhere({ email }).first();
    if (existing) {
      // Same generic, non-enumerating message as signup's duplicate check.
      throw new ConflictError('Username or email already in use');
    }

    const passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptSaltRounds);
    const newUser = await db.transaction(async (trx) => {
      const [user] = await trx('users')
        .insert({ username, email, password_hash: passwordHash })
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
    await requireWorkspaceAdmin(db, req.user.id, workspaceId);

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
