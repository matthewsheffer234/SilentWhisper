import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import {
  assertUuid,
  assertName,
  assertUsername,
  assertEmail,
  assertEnum,
  assertBoundedInt,
  MAX_USERNAME_LENGTH,
  ASSIGNABLE_ORG_ROLES,
} from '../validation.js';
import { invitationCreateLimiter, memberSearchLimiter } from '../auth/rateLimit.js';
import { generateInvitationToken, hashInvitationToken, INVITATION_TOKEN_TTL_MS } from '../auth/invitationTokens.js';
import { requireOrgPermission, requireOrgNotArchived, isSystemAdminUser } from '../authz/membershipService.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from '../errors.js';

export const organizationsRouter = Router();

organizationsRouter.use(requireAuth);

// System-admin only — plain isSystemAdminUser check, deliberately not
// requireSystemPermission (FEATURE_REQUEST.md entry 1, slice 2):
// requireSystemPermission's OR-fallback (any workspace OWNER/MANAGER) exists
// narrowly to avoid locking out existing workspace admins from AI-settings/
// audit during slice 1's transition. Extending that fallback to "any
// workspace admin can create an organization" would be a real, unintended
// privilege widening, not a continuation of its purpose.
organizationsRouter.post('/', async (req, res, next) => {
  try {
    if (!(await isSystemAdminUser(db, req.user.id))) {
      throw new ForbiddenError('System admin privileges required');
    }
    const name = assertName(req.body?.name, 'organization name');

    // Auto-enrolls the creator as ORG_ADMIN, transactionally — an org with
    // zero members is a dead end nobody could ever manage without going
    // back to a system admin.
    const org = await db.transaction(async (trx) => {
      const [o] = await trx('organizations').insert({ name }).returning(['id', 'name', 'created_at']);
      await trx('organization_members').insert({ organization_id: o.id, user_id: req.user.id, org_role: 'ORG_ADMIN' });
      return o;
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ORGANIZATION_CREATED',
      targetResource: org.id,
      payload: { name: org.name },
    });

    res.status(201).json({ id: org.id, name: org.name, role: 'ORG_ADMIN' });
  } catch (err) {
    next(err);
  }
});

// Caller's own orgs, or every org if system admin — mirrors GET /workspaces'
// join-and-shape pattern. role: null in the system-admin-sees-all branch is
// a deliberate response-shape asymmetry (no per-row membership guaranteed),
// same as GET /workspaces/discoverable's existing precedent of omitting
// `role` when the caller has none yet.
organizationsRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = await isSystemAdminUser(db, req.user.id);
    const rows = isAdmin
      ? await db('organizations').select('id', 'name', 'created_at', 'archived_at').orderBy('created_at', 'asc')
      : await db('organizations as o')
          .join('organization_members as om', function joinMembers() {
            this.on('om.organization_id', '=', 'o.id').andOn('om.user_id', '=', db.raw('?', [req.user.id]));
          })
          .select('o.id', 'o.name', 'o.created_at', 'o.archived_at', 'om.org_role')
          .orderBy('o.created_at', 'asc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        archivedAt: r.archived_at,
        role: r.org_role ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// System Admin panel: manage organizations and existing users. Organization
// lifecycle (rename/archive/unarchive) stays system-admin-only — same direct
// isSystemAdminUser gate as POST / above, not requireOrgPermission — org
// lifecycle was never ORG_ADMIN-manageable by design, extended consistently
// here rather than re-litigated.
organizationsRouter.patch('/:orgId', async (req, res, next) => {
  try {
    if (!(await isSystemAdminUser(db, req.user.id))) {
      throw new ForbiddenError('System admin privileges required');
    }
    const orgId = assertUuid(req.params.orgId, 'orgId');
    const name = assertName(req.body?.name, 'organization name');

    const org = await db('organizations').where({ id: orgId }).first('name');
    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    await db('organizations').where({ id: orgId }).update({ name });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ORGANIZATION_RENAMED',
      targetResource: orgId,
      payload: { fromName: org.name, toName: name },
    });

    res.json({ id: orgId, name });
  } catch (err) {
    next(err);
  }
});

// Idempotent (200 always; writes + audits only on an actual NULL -> set
// transition) — mirrors POST /:workspaceId/archive's own convention exactly.
organizationsRouter.post('/:orgId/archive', async (req, res, next) => {
  try {
    if (!(await isSystemAdminUser(db, req.user.id))) {
      throw new ForbiddenError('System admin privileges required');
    }
    const orgId = assertUuid(req.params.orgId, 'orgId');
    const org = await db('organizations').where({ id: orgId }).first('archived_at');
    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    if (!org.archived_at) {
      await db('organizations').where({ id: orgId }).update({ archived_at: new Date(), archived_by: req.user.id });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'ORGANIZATION_ARCHIVE_STATUS_CHANGE',
        targetResource: orgId,
        payload: { action: 'archive' },
      });
    }

    res.status(200).json({ id: orgId, archivedAt: org.archived_at ?? new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.post('/:orgId/unarchive', async (req, res, next) => {
  try {
    if (!(await isSystemAdminUser(db, req.user.id))) {
      throw new ForbiddenError('System admin privileges required');
    }
    const orgId = assertUuid(req.params.orgId, 'orgId');
    const org = await db('organizations').where({ id: orgId }).first('archived_at');
    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    if (org.archived_at) {
      await db('organizations').where({ id: orgId }).update({ archived_at: null, archived_by: null });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'ORGANIZATION_ARCHIVE_STATUS_CHANGE',
        targetResource: orgId,
        payload: { action: 'unarchive' },
      });
    }

    res.status(200).json({ id: orgId, archivedAt: null });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.get('/:orgId/members', async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_MANAGE_MEMBERS);

    const rows = await db('organization_members as om')
      .join('users', 'users.id', 'om.user_id')
      .where('om.organization_id', orgId)
      .select('users.id', 'users.username', 'users.display_name', 'om.org_role')
      .orderBy('users.username', 'asc');

    res.json(
      rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, role: r.org_role })),
    );
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md's "unified people picker" entry. Same shape and
// reasoning as workspaces.js's GET /:workspaceId/people-search — candidate
// pool is every existing user account system-wide, matching POST
// /:orgId/members's own lookup exactly, gated identically
// (ORG_MANAGE_MEMBERS) since this reveals matching accounts by email.
organizationsRouter.get('/:orgId/people-search', memberSearchLimiter, async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_MANAGE_MEMBERS);

    const limit =
      req.query.limit !== undefined ? assertBoundedInt(req.query.limit, { min: 1, max: 20 }, 'limit') : 8;
    let q = '';
    if (req.query.q !== undefined) {
      q = String(req.query.q);
      if (q.length > MAX_USERNAME_LENGTH) {
        throw new ValidationError(`q must be at most ${MAX_USERNAME_LENGTH} characters`);
      }
    }

    let query = db('users').leftJoin('organization_members as om', function joinMembership() {
      this.on('om.user_id', '=', 'users.id').andOnVal('om.organization_id', '=', orgId);
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
      .select('users.id', 'users.username', 'users.display_name', 'users.email', 'om.user_id as memberUserId');

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

// Direct-add of an *already-existing* user by username — mirrors
// POST /:workspaceId/members exactly. Invitations (below) are for people
// who don't have an account yet.
organizationsRouter.post('/:orgId/members', async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_MANAGE_MEMBERS);
    await requireOrgNotArchived(db, orgId);

    const username = assertUsername(req.body?.username);
    const role = req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_ORG_ROLES, 'role') : 'ORG_MEMBER';

    const targetUser = await db('users').where({ username }).first('id', 'username');
    if (!targetUser) {
      throw new ValidationError('No user with that username exists');
    }

    const existingRole = await db('organization_members')
      .where({ organization_id: orgId, user_id: targetUser.id })
      .first('org_role');
    if (existingRole) {
      throw new ConflictError('User is already a member of this organization');
    }

    await db('organization_members').insert({ organization_id: orgId, user_id: targetUser.id, org_role: role });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ORGANIZATION_MEMBERSHIP_CHANGE',
      targetResource: orgId,
      payload: { action: 'add', addedUserId: targetUser.id, addedUsername: targetUser.username, role },
    });

    res.status(201).json({ userId: targetUser.id, username: targetUser.username, role });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.patch('/:orgId/members/:userId', async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    const targetUserId = assertUuid(req.params.userId, 'userId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_MANAGE_MEMBERS);
    await requireOrgNotArchived(db, orgId);

    const role = assertEnum(req.body?.role, ASSIGNABLE_ORG_ROLES, 'role');

    const targetRow = await db('organization_members as om')
      .join('users', 'users.id', 'om.user_id')
      .where({ 'om.organization_id': orgId, 'om.user_id': targetUserId })
      .first('users.username', 'om.org_role');
    if (!targetRow) {
      throw new NotFoundError('Organization member not found');
    }

    // No "last admin" guard here, unlike workspaces' last-owner guard —
    // deliberate (FEATURE_REQUEST.md entry 1's locked-in decision):
    // organizations have no owner-uniqueness invariant, so an org can end up
    // with zero ORG_ADMIN members. The system-admin override remains the
    // escape hatch (it checks org existence, not org-admin existence).
    await db('organization_members')
      .where({ organization_id: orgId, user_id: targetUserId })
      .update({ org_role: role });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ORGANIZATION_MEMBERSHIP_CHANGE',
      targetResource: orgId,
      payload: {
        action: 'role_change',
        targetUserId,
        targetUsername: targetRow.username,
        fromRole: targetRow.org_role,
        toRole: role,
      },
    });

    res.json({ userId: targetUserId, username: targetRow.username, role });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.delete('/:orgId/members/:userId', async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    const targetUserId = assertUuid(req.params.userId, 'userId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_MANAGE_MEMBERS);
    await requireOrgNotArchived(db, orgId);

    const targetRow = await db('organization_members as om')
      .join('users', 'users.id', 'om.user_id')
      .where({ 'om.organization_id': orgId, 'om.user_id': targetUserId })
      .first('users.username');
    if (!targetRow) {
      throw new NotFoundError('Organization member not found');
    }

    // Deliberately no cascade — org and workspace membership are
    // independent (FEATURE_REQUEST.md entry 1's locked-in decision).
    // Removing someone from an org does not touch their workspace_members
    // rows, including any workspace under this org.
    await db('organization_members').where({ organization_id: orgId, user_id: targetUserId }).del();

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'ORGANIZATION_MEMBERSHIP_CHANGE',
      targetResource: orgId,
      payload: { action: 'remove', targetUserId, targetUsername: targetRow.username },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Raw token returned once — no email infra exists in this project, same
// out-of-band precedent as admin-set passwords (workspaces.js's
// POST /:workspaceId/users).
organizationsRouter.post('/:orgId/invitations', invitationCreateLimiter, async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_INVITE);
    await requireOrgNotArchived(db, orgId);

    const email = assertEmail(req.body?.email);
    const invitedRole =
      req.body?.role !== undefined ? assertEnum(req.body.role, ASSIGNABLE_ORG_ROLES, 'role') : 'ORG_MEMBER';

    const rawToken = generateInvitationToken();
    const [invitation] = await db('invitations')
      .insert({
        scope_type: 'ORGANIZATION',
        organization_id: orgId,
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
      payload: { scopeType: 'ORGANIZATION', organizationId: orgId, email, invitedRole },
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

// Pending-invitations roster (slice 3): mirrors the workspace-scoped
// equivalent in workspaces.js exactly — same reasoning (the only invitation
// data the frontend would otherwise see is the just-created token, gone on
// reload), same permission gate as the POST above.
organizationsRouter.get('/:orgId/invitations', async (req, res, next) => {
  try {
    const orgId = assertUuid(req.params.orgId, 'orgId');
    await requireOrgPermission(db, req.user.id, orgId, PERMISSIONS.ORG_INVITE);

    const rows = await db('invitations as i')
      .join('users as u', 'u.id', 'i.invited_by')
      .where({ 'i.scope_type': 'ORGANIZATION', 'i.organization_id': orgId, 'i.status': 'PENDING' })
      .andWhere('i.expires_at', '>', new Date())
      .select(
        'i.id',
        'i.email',
        'i.invited_role',
        'i.expires_at',
        'u.username as invited_by_username',
        'u.display_name as invited_by_display_name',
      )
      .orderBy('i.created_at', 'desc');

    res.json(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
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
