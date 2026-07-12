import crypto from 'node:crypto';
import { config } from '../config.js';
import { UnauthorizedError } from '../errors.js';

// Refresh tokens are opaque random values; only a SHA-256 hash is ever
// stored (PROJECT_PLAN.md Section 4: "refresh_tokens stores only a hash of
// the token ... revocation is a row update, not a secret-recovery risk").
function generateRawToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export class RefreshReuseDetectedError extends UnauthorizedError {
  constructor(userId) {
    super('Refresh token reuse detected');
    this.userId = userId;
  }
}

export async function issueRefreshToken(db, userId, trx = db) {
  const rawToken = generateRawToken();
  await trx('refresh_tokens').insert({
    user_id: userId,
    token_hash: hashToken(rawToken),
    expires_at: new Date(Date.now() + config.auth.refreshTokenTtlMs),
  });
  return rawToken;
}

/**
 * Rotates a refresh token: the presented token is revoked and a new one is
 * issued in its place, inside one transaction with the row locked
 * (`forUpdate`) so two concurrent refresh calls with the same token can't
 * both succeed and silently double-issue.
 *
 * If the presented token was *already* revoked, that's a reuse signal — a
 * token that should no longer exist in valid form was presented anyway,
 * meaning either a client retried after a race or (worse) a stolen token is
 * being replayed after the legitimate client already rotated past it. Either
 * way, the safe response is the same: revoke every other outstanding
 * refresh token for that user, forcing every session to re-authenticate.
 */
export async function rotateRefreshToken(db, rawToken) {
  const tokenHash = hashToken(rawToken);

  // Throwing out of a `db.transaction()` callback rolls back everything it
  // did — including, in the reuse-detection branch, the very "revoke every
  // other token" side effect we need to survive the failure. So the
  // callback always resolves (never throws) and reports what happened via a
  // discriminated result instead; the actual error is thrown afterward, once
  // the transaction has already committed.
  const result = await db.transaction(async (trx) => {
    const row = await trx('refresh_tokens').where({ token_hash: tokenHash }).forUpdate().first();

    if (!row) {
      return { kind: 'invalid' };
    }
    if (row.revoked_at) {
      await trx('refresh_tokens')
        .where({ user_id: row.user_id, revoked_at: null })
        .update({ revoked_at: new Date() });
      return { kind: 'reuse', userId: row.user_id };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { kind: 'expired' };
    }

    await trx('refresh_tokens').where({ id: row.id }).update({ revoked_at: new Date() });
    const newRawToken = await issueRefreshToken(db, row.user_id, trx);
    return { kind: 'ok', userId: row.user_id, newRawToken };
  });

  if (result.kind === 'invalid') throw new UnauthorizedError('Invalid refresh token');
  if (result.kind === 'expired') throw new UnauthorizedError('Refresh token expired');
  if (result.kind === 'reuse') throw new RefreshReuseDetectedError(result.userId);
  return { userId: result.userId, newRawToken: result.newRawToken };
}

// Returns the affected row's user_id (or null if the token was unknown or
// already revoked) so callers — e.g. the logout route — can audit the event
// against the right actor without a separate lookup.
export async function revokeRefreshToken(db, rawToken) {
  const tokenHash = hashToken(rawToken);
  const rows = await db('refresh_tokens')
    .where({ token_hash: tokenHash, revoked_at: null })
    .update({ revoked_at: new Date() })
    .returning('user_id');
  return rows[0]?.user_id ?? null;
}

export async function revokeAllRefreshTokensForUser(db, userId) {
  await db('refresh_tokens').where({ user_id: userId, revoked_at: null }).update({ revoked_at: new Date() });
}
