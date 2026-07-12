import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertName, assertUsername, assertEnum, CREATABLE_CHANNEL_TYPES, WORKSPACE_ROLES } from '../validation.js';
import {
  requireWorkspaceMember,
  requireWorkspaceAdmin,
  requireChannelMember,
  getWorkspaceRole,
  getChannel,
  isChannelMember,
} from '../authz/membershipService.js';
import { ValidationError, ConflictError } from '../errors.js';

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
      .select('w.id', 'w.name', 'w.owner_id', 'wm.system_role')
      .orderBy('w.created_at', 'asc');

    res.json(rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, role: r.system_role })));
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

workspacesRouter.post('/:workspaceId/channels', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);

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
