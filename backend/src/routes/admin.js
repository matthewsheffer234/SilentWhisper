import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertUsername, assertEmail } from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { revokeAllRefreshTokensForUser } from '../auth/refreshTokens.js';
import { adminUserCreateLimiter, adminPasswordResetLimiter } from '../auth/rateLimit.js';
import { isSystemAdminUser } from '../authz/membershipService.js';
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from '../errors.js';

// System-admin-only account lifecycle (FEATURE_REQUEST.md entry 1, slice 4,
// SLICE_4_PLAN.md §4.3). Every route here is gated by a direct
// isSystemAdminUser check, not requireSystemPermission's OR-fallback — see
// that function's own comment in membershipService.js: the fallback exists
// narrowly to avoid locking out pre-existing workspace admins from
// AI-settings/audit during slice 1's transition, and extending it to
// "any workspace admin creates/disables any account" would be a real,
// unintended privilege widening (the same reasoning organizations.js's
// POST / and workspaces.js's GET /admin/all already use).
export const adminRouter = Router();

adminRouter.use(requireAuth);

async function requireSystemAdmin(req) {
  if (!(await isSystemAdminUser(db, req.user.id))) {
    throw new ForbiddenError('System admin privileges required');
  }
}

// Bare account creation, no workspace tie — retires
// POST /:workspaceId/users (workspaces.js), which required the caller to
// already administer some workspace. organizationId is optional: when
// given, only existence is checked (a system admin can attach an account to
// any org, no membership check, since this route already implies full
// cross-org authority); when omitted, auto-enrolls into the earliest-created
// org — migration 0012 guarantees at least one exists, so this path never
// hits resolveCallerOrganization's "you belong to no org" branch (that one's
// about the *caller's own* memberships, irrelevant here).
adminRouter.post('/users', adminUserCreateLimiter, async (req, res, next) => {
  try {
    await requireSystemAdmin(req);

    const username = assertUsername(req.body?.username);
    const email = assertEmail(req.body?.email);
    const passwordError = assertValidPassword(req.body?.password);
    if (passwordError) throw new ValidationError(passwordError);
    const requestedOrgId =
      req.body?.organizationId !== undefined ? assertUuid(req.body.organizationId, 'organizationId') : null;

    const existing = await db('users').where({ username }).orWhere({ email }).first();
    if (existing) {
      // Same generic, non-enumerating message as signup's/the retired
      // workspace-scoped route's duplicate check.
      throw new ConflictError('Username or email already in use');
    }

    const passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptSaltRounds);
    const newUser = await db.transaction(async (trx) => {
      const [user] = await trx('users')
        .insert({ username, email, password_hash: passwordHash, display_name: username })
        .returning(['id', 'username', 'email']);

      let organizationId = requestedOrgId;
      if (organizationId) {
        const org = await trx('organizations').where({ id: organizationId }).first('id');
        if (!org) {
          // 400, not 404 — a body-param problem, not a path resource lookup.
          throw new ValidationError('No organization with that id exists');
        }
      } else {
        const earliestOrg = await trx('organizations').orderBy('created_at', 'asc').first('id');
        organizationId = earliestOrg.id;
      }
      await trx('organization_members').insert({ organization_id: organizationId, user_id: user.id, org_role: 'ORG_MEMBER' });
      return { ...user, organizationId };
    });

    // Reuses USER_ACCOUNT_CREATED — its only prior writer,
    // POST /:workspaceId/users, is deleted in this same slice, so there's
    // never a period with two writers of the same audit type.
    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'USER_ACCOUNT_CREATED',
      targetResource: newUser.id,
      payload: { newUserId: newUser.id, username: newUser.username, email: newUser.email, organizationId: newUser.organizationId },
    });

    res.status(201).json({
      userId: newUser.id,
      username: newUser.username,
      email: newUser.email,
      organizationId: newUser.organizationId,
    });
  } catch (err) {
    next(err);
  }
});

// Global account roster — cheap read, no limiter (matches GET /organizations'
// precedent).
adminRouter.get('/users', async (req, res, next) => {
  try {
    await requireSystemAdmin(req);

    const rows = await db('users')
      .select('id', 'username', 'email', 'status', 'is_system_admin')
      .orderBy('username', 'asc');

    res.json(
      rows.map((r) => ({
        userId: r.id,
        username: r.username,
        email: r.email,
        status: r.status,
        isSystemAdmin: r.is_system_admin,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Disable/enable share adminPasswordResetLimiter's bucket — same class of
// "administrative action against another account" as a password reset.
adminRouter.post('/users/:userId/disable', adminPasswordResetLimiter, async (req, res, next) => {
  try {
    await requireSystemAdmin(req);
    const targetUserId = assertUuid(req.params.userId, 'userId');

    if (targetUserId === req.user.id) {
      // A small, explicitly-flagged safety addition beyond the literal
      // design text — prevents a sole system admin from locking themselves
      // out.
      throw new ValidationError('Cannot disable your own account');
    }

    const target = await db('users').where({ id: targetUserId }).first('id', 'status');
    if (!target) {
      throw new NotFoundError('User not found');
    }

    if (target.status !== 'DISABLED') {
      await db('users').where({ id: targetUserId }).update({ status: 'DISABLED' });
      await revokeAllRefreshTokensForUser(db, targetUserId);
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'USER_STATUS_CHANGE',
        targetResource: targetUserId,
        payload: { targetUserId, action: 'disable' },
      });
    }

    res.status(200).json({ userId: targetUserId, status: 'DISABLED' });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users/:userId/enable', adminPasswordResetLimiter, async (req, res, next) => {
  try {
    await requireSystemAdmin(req);
    const targetUserId = assertUuid(req.params.userId, 'userId');

    const target = await db('users').where({ id: targetUserId }).first('id', 'status');
    if (!target) {
      throw new NotFoundError('User not found');
    }

    if (target.status === 'DISABLED') {
      await db('users').where({ id: targetUserId }).update({ status: 'ACTIVE' });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'USER_STATUS_CHANGE',
        targetResource: targetUserId,
        payload: { targetUserId, action: 'enable' },
      });
    }

    res.status(200).json({ userId: targetUserId, status: 'ACTIVE' });
  } catch (err) {
    next(err);
  }
});
