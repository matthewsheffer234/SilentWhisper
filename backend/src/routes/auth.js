import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { appendAuditEvent, ANONYMOUS_ACTOR_ID } from '../audit/auditService.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { signAccessToken } from '../auth/jwt.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  RefreshReuseDetectedError,
} from '../auth/refreshTokens.js';
import { loginIpLimiter, loginUsernameLimiter, changePasswordLimiter } from '../auth/rateLimit.js';
import { requireAuth } from '../auth/requireAuth.js';
import { UnauthorizedError, ValidationError } from '../errors.js';

export const authRouter = Router();

// Cookie is scoped to /api/auth specifically — the only paths that ever need
// to read it — rather than the whole origin, tightening exposure beyond the
// plan's httpOnly/Secure/SameSite=Strict minimum (Section 3).
const REFRESH_COOKIE_NAME = 'refresh_token';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'strict',
  path: '/api/auth',
};

// Exported (slice 2, FEATURE_REQUEST.md entry 1): invitations.js's
// redemption route logs a newly-created account in exactly the same way
// signup does, and needs to set the identical cookie — re-exporting this
// one function keeps the cookie shape (httpOnly/secure/sameSite/path)
// defined in exactly one place rather than risking a second, driftable copy.
export function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: config.auth.refreshTokenTtlMs,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

// Self-service signup is closed (FEATURE_REQUEST.md entry 1, slice 4): every
// account now originates from a system admin (scripts/create-first-admin.mjs,
// POST /api/admin/users) or from redeeming an invitation
// (POST /api/invitations/:token/accept, which shares this file's
// setRefreshCookie and issues the same response shape signup used to).
// AUTH_SIGNUP is left as a dead-but-historical audit action type — existing
// rows keep it, nothing new writes it.

// Lets the frontend restore a session after a page reload: it can silently
// call /refresh to get a fresh access token from the httpOnly cookie, but
// /refresh only returns a token, not the user object — this fills that gap
// without requiring the client to have cached user info anywhere itself.
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await db('users')
      .where({ id: req.user.id })
      .first(['id', 'username', 'display_name', 'email', 'is_system_admin']);
    if (!user) {
      throw new UnauthorizedError('User no longer exists');
    }
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        isSystemAdmin: user.is_system_admin,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', loginIpLimiter, loginUsernameLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new ValidationError('username and password are required');
    }

    const user = await db('users').where({ username }).first();
    if (!user) {
      await appendAuditEvent(db, {
        actorId: ANONYMOUS_ACTOR_ID,
        actorIp: req.ip,
        actionType: 'AUTH_LOGIN_FAILURE',
        targetResource: username,
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      await appendAuditEvent(db, {
        actorId: user.id,
        actorIp: req.ip,
        actionType: 'AUTH_LOGIN_FAILURE',
        targetResource: username,
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    // Account lifecycle (FEATURE_REQUEST.md entry 1, slice 4): a disabled
    // user's outstanding refresh tokens are already revoked at disable-time
    // (revokeAllRefreshTokensForUser in admin.js), so POST /refresh already
    // rejects them via the existing reuse-detection branch with no code
    // change needed there — this is the only genuine gap. Identical generic
    // message to a wrong-password attempt; never leaks that the account
    // exists but is disabled.
    if (user.status === 'DISABLED') {
      await appendAuditEvent(db, {
        actorId: user.id,
        actorIp: req.ip,
        actionType: 'AUTH_LOGIN_FAILURE',
        targetResource: username,
        payload: { reason: 'disabled' },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    const accessToken = signAccessToken({ userId: user.id, username: user.username, displayName: user.display_name });
    const refreshToken = await issueRefreshToken(db, user.id);
    setRefreshCookie(res, refreshToken);

    await appendAuditEvent(db, {
      actorId: user.id,
      actorIp: req.ip,
      actionType: 'AUTH_LOGIN',
      targetResource: user.username,
    });

    res.json({
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        isSystemAdmin: user.is_system_admin,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  try {
    if (!rawToken) {
      throw new UnauthorizedError('Missing refresh token');
    }

    const { userId, newRawToken } = await rotateRefreshToken(db, rawToken);
    const user = await db('users').where({ id: userId }).first();

    const accessToken = signAccessToken({ userId, username: user.username, displayName: user.display_name });
    setRefreshCookie(res, newRawToken);

    await appendAuditEvent(db, {
      actorId: userId,
      actorIp: req.ip,
      actionType: 'AUTH_TOKEN_REFRESH',
    });

    res.json({ accessToken });
  } catch (err) {
    clearRefreshCookie(res);
    if (err instanceof RefreshReuseDetectedError) {
      appendAuditEvent(db, {
        actorId: err.userId,
        actorIp: req.ip,
        actionType: 'AUTH_REFRESH_REUSE_DETECTED',
      }).finally(() => next(new UnauthorizedError('Invalid refresh token')));
      return;
    }
    next(err);
  }
});

// Self-service password change (FEATURE_REQUEST.md entry: there was
// previously no way for any user to change their own password without
// direct database access). currentPassword mismatch -> 401
// (UnauthorizedError), like login — this is a credential check, not a
// validation failure.
authRouter.post('/change-password', requireAuth, changePasswordLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string') {
      throw new ValidationError('currentPassword is required');
    }

    const user = await db('users').where({ id: req.user.id }).first();
    if (!user) {
      throw new UnauthorizedError('User no longer exists');
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatches) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const passwordError = assertValidPassword(newPassword);
    if (passwordError) throw new ValidationError(passwordError);

    const passwordHash = await bcrypt.hash(newPassword, config.auth.bcryptSaltRounds);
    await db('users').where({ id: user.id }).update({ password_hash: passwordHash });

    // A password change is exactly the kind of event that should force
    // re-authentication everywhere else (the same reuse-detection precedent
    // in auth/refreshTokens.js) — revokes every outstanding refresh token,
    // including this request's own current one. That doesn't log *this*
    // session out, though: a fresh access token + refresh token are issued
    // immediately below, the same shape /login returns, so this tab keeps
    // working without interruption while every other session is forced to
    // sign back in.
    await revokeAllRefreshTokensForUser(db, user.id);

    const accessToken = signAccessToken({ userId: user.id, username: user.username, displayName: user.display_name });
    const refreshToken = await issueRefreshToken(db, user.id);
    setRefreshCookie(res, refreshToken);

    await appendAuditEvent(db, {
      actorId: user.id,
      actorIp: req.ip,
      actionType: 'AUTH_PASSWORD_CHANGE',
    });

    res.json({
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        isSystemAdmin: user.is_system_admin,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (rawToken) {
      const userId = await revokeRefreshToken(db, rawToken);
      if (userId) {
        await appendAuditEvent(db, {
          actorId: userId,
          actorIp: req.ip,
          actionType: 'AUTH_LOGOUT',
        });
      }
    }
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
