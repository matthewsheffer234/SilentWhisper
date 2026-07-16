import { verifyAccessToken } from './jwt.js';
import { UnauthorizedError } from '../errors.js';

// Authorization is enforced server-side on every REST call (PROJECT_PLAN.md
// Section 3, Authorization Model) — this middleware is the one place a
// request's identity is established; route handlers never trust anything
// the client claims about who it is beyond this.
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }
  try {
    const { userId, username, displayName } = verifyAccessToken(token);
    req.user = { id: userId, username, displayName };
    next();
  } catch (err) {
    next(err);
  }
}
