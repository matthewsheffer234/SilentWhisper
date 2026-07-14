import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { assertUuid, assertUsername } from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { signAccessToken } from '../auth/jwt.js';
import { issueRefreshToken } from '../auth/refreshTokens.js';
import { setRefreshCookie } from './auth.js';
import { signupIpLimiter } from '../auth/rateLimit.js';
import { hashInvitationToken } from '../auth/invitationTokens.js';
import { requireOrgPermission, requireWorkspacePermission } from '../authz/membershipService.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { ValidationError, ConflictError, NotFoundError } from '../errors.js';

export const invitationsRouter = Router();

// No router-wide requireAuth (unlike workspaces.js) — this router mixes
// public routes (redemption, context-preview) with an authenticated one
// (revoke), mirroring auth.js's per-route pattern rather than applying auth
// once at the top.

// GET /api/invitations/:token — public. Shows context before redemption
// without leaking anything about an invalid/expired/already-used token —
// the same existence-hiding instinct as every membership 404 elsewhere,
// applied to an unauthenticated public surface instead of a membership.
invitationsRouter.get('/:token', async (req, res, next) => {
  try {
    const rawToken = req.params.token;
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new NotFoundError('Invitation not found');
    }

    const row = await db('invitations').where({ token_hash: hashInvitationToken(rawToken) }).first();
    if (!row || row.status !== 'PENDING' || new Date(row.expires_at) < new Date()) {
      // Same generic 404 for "doesn't exist" / "revoked" / "already
      // accepted" / "expired" — a public caller must not be able to
      // distinguish these, same as a non-member workspace 404 not
      // distinguishing "private" from "doesn't exist."
      throw new NotFoundError('Invitation not found');
    }

    const scopeRow =
      row.scope_type === 'ORGANIZATION'
        ? await db('organizations').where({ id: row.organization_id }).first('name')
        : await db('workspaces').where({ id: row.workspace_id }).first('name');
    const inviter = await db('users').where({ id: row.invited_by }).first('username');

    res.json({
      scopeType: row.scope_type,
      scopeName: scopeRow?.name ?? null,
      invitedRole: row.invited_role,
      invitedByUsername: inviter?.username ?? null,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:token/accept — public. Creates the account,
// attaches the invited-role membership, marks the invitation ACCEPTED, all
// in one transaction, then logs the new user in immediately — same
// response shape as POST /auth/signup. Rate-limited with signupIpLimiter,
// not a dedicated limiter: this *is* a signup from an abuse standpoint.
invitationsRouter.post('/:token/accept', signupIpLimiter, async (req, res, next) => {
  try {
    const rawToken = req.params.token;
    const tokenHash = hashInvitationToken(rawToken);
    const username = assertUsername(req.body?.username);
    const passwordError = assertValidPassword(req.body?.password);
    if (passwordError) throw new ValidationError(passwordError);

    const result = await db.transaction(async (trx) => {
      // Row-locked so two concurrent accept calls on the same token can't
      // both succeed — same forUpdate precedent as rotateRefreshToken.
      const row = await trx('invitations').where({ token_hash: tokenHash }).forUpdate().first();
      if (!row || row.status !== 'PENDING' || new Date(row.expires_at) < new Date()) {
        return { kind: 'invalid' };
      }

      const existing = await trx('users').where({ username }).orWhere({ email: row.email }).first();
      if (existing) {
        return { kind: 'conflict' };
      }

      const passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptSaltRounds);
      const [user] = await trx('users')
        .insert({ username, email: row.email, password_hash: passwordHash, display_name: username })
        .returning(['id', 'username', 'email']);

      if (row.scope_type === 'ORGANIZATION') {
        await trx('organization_members').insert({
          organization_id: row.organization_id,
          user_id: user.id,
          org_role: row.invited_role,
        });
      } else {
        await trx('workspace_members').insert({
          workspace_id: row.workspace_id,
          user_id: user.id,
          system_role: row.invited_role,
        });
        // Signup-parity auto-enrollment: a workspace-invited account still
        // needs some org membership (same reason POST /auth/signup gained
        // one this slice) — skipped when the invitation was itself
        // org-scoped, since that insert above already is the org
        // membership.
        const defaultOrg = await trx('organizations').orderBy('created_at', 'asc').first('id');
        await trx('organization_members').insert({ organization_id: defaultOrg.id, user_id: user.id, org_role: 'ORG_MEMBER' });
      }

      await trx('invitations').where({ id: row.id }).update({ status: 'ACCEPTED', accepted_at: new Date(), accepted_by: user.id });

      const accessToken = signAccessToken({ userId: user.id, username: user.username });
      const refreshToken = await issueRefreshToken(db, user.id, trx);
      return { kind: 'ok', user, accessToken, refreshToken, invitationId: row.id, scopeType: row.scope_type };
    });

    if (result.kind === 'invalid') throw new NotFoundError('Invitation not found');
    if (result.kind === 'conflict') throw new ConflictError('Username or email already in use');

    // The refresh cookie's path (/api/auth) governs where it's sent back to,
    // not where it can be set from — setting it here from /api/invitations
    // works the same as auth.js's own routes setting it.
    setRefreshCookie(res, result.refreshToken);

    await appendAuditEvent(db, {
      actorId: result.user.id,
      actorIp: req.ip,
      actionType: 'INVITATION_REDEEMED',
      targetResource: result.invitationId,
      payload: { scopeType: result.scopeType },
    });

    res.status(201).json({
      accessToken: result.accessToken,
      user: { id: result.user.id, username: result.user.username, email: result.user.email },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:id/revoke — the inviter, or an equivalent
// permission-holder on the invitation's own scope, may revoke. Idempotent-
// safe: revoking an already-non-PENDING invitation is a no-op 204, not an
// error, matching archive/unarchive/subscribe's existing convention.
invitationsRouter.post('/:id/revoke', requireAuth, async (req, res, next) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    const row = await db('invitations').where({ id }).first();
    if (!row) {
      throw new NotFoundError('Invitation not found');
    }

    const isInviter = row.invited_by === req.user.id;
    if (!isInviter) {
      if (row.scope_type === 'ORGANIZATION') {
        await requireOrgPermission(db, req.user.id, row.organization_id, PERMISSIONS.ORG_INVITE);
      } else {
        await requireWorkspacePermission(db, req.user.id, row.workspace_id, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
      }
    }

    if (row.status === 'PENDING') {
      await db('invitations').where({ id }).update({ status: 'REVOKED' });
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'INVITATION_REVOKED',
        targetResource: id,
        payload: { scopeType: row.scope_type },
      });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
