import { verifyAccessToken } from './jwt.js';
import { UnauthorizedError } from '../errors.js';
import { db } from '../db.js';

// Authorization is enforced server-side on every REST call (PROJECT_PLAN.md
// Section 3, Authorization Model) — this middleware is the one place a
// request's identity is established; route handlers never trust anything
// the client claims about who it is beyond this.
//
// The JWT alone only proves who was issued this token at sign time — it
// says nothing about whether the account is still active *now*. A disabled
// account's outstanding access token (up to ~15 minutes old) used to keep
// working on every REST call until it naturally expired; this re-checks
// `users.status` against the database on every request specifically to
// close that window immediately instead (FEATURE_REQUEST.md entry 1, same
// requirement as ws/server.js's handleAuthenticate).
export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }
  try {
    const { userId, username, displayName } = verifyAccessToken(token);
    const user = await db('users').where({ id: userId }).first('status');
    // Identical message to an invalid/expired token — a disabled account
    // must not be able to distinguish "disabled" from "token no longer
    // valid" (mirrors routes/auth.js's login rejection, which gives a
    // disabled account the exact message a wrong password would get).
    if (!user || user.status !== 'ACTIVE') {
      next(new UnauthorizedError('Invalid or expired access token'));
      return;
    }
    req.user = { id: userId, username, displayName };
    next();
  } catch (err) {
    next(err);
  }
}
