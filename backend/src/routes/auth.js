import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { appendAuditEvent, ANONYMOUS_ACTOR_ID } from '../audit/auditService.js';
import { assertUsername, assertEmail } from '../validation.js';
import { assertValidPassword } from '../auth/passwordPolicy.js';
import { signAccessToken } from '../auth/jwt.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  RefreshReuseDetectedError,
} from '../auth/refreshTokens.js';
import { loginIpLimiter, loginUsernameLimiter, signupIpLimiter } from '../auth/rateLimit.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../errors.js';

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

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: config.auth.refreshTokenTtlMs,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

authRouter.post('/signup', signupIpLimiter, async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    assertUsername(username);
    assertEmail(email);
    const passwordError = assertValidPassword(password);
    if (passwordError) throw new ValidationError(passwordError);

    const existing = await db('users')
      .where({ username })
      .orWhere({ email })
      .first();
    if (existing) {
      // Deliberately generic — doesn't reveal which field collided, to avoid
      // making this an account-enumeration oracle.
      throw new ConflictError('Username or email already in use');
    }

    const passwordHash = await bcrypt.hash(password, config.auth.bcryptSaltRounds);
    const [user] = await db('users')
      .insert({ username, email, password_hash: passwordHash })
      .returning(['id', 'username', 'email']);

    const accessToken = signAccessToken({ userId: user.id, username: user.username });
    const refreshToken = await issueRefreshToken(db, user.id);
    setRefreshCookie(res, refreshToken);

    await appendAuditEvent(db, {
      actorId: user.id,
      actorIp: req.ip,
      actionType: 'AUTH_SIGNUP',
      targetResource: user.username,
    });

    res.status(201).json({ accessToken, user: { id: user.id, username: user.username, email: user.email } });
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

    const accessToken = signAccessToken({ userId: user.id, username: user.username });
    const refreshToken = await issueRefreshToken(db, user.id);
    setRefreshCookie(res, refreshToken);

    await appendAuditEvent(db, {
      actorId: user.id,
      actorIp: req.ip,
      actionType: 'AUTH_LOGIN',
      targetResource: user.username,
    });

    res.json({ accessToken, user: { id: user.id, username: user.username, email: user.email } });
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

    const accessToken = signAccessToken({ userId, username: user.username });
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
