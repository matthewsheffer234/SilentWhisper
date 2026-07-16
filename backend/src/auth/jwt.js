import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { UnauthorizedError } from '../errors.js';

export function signAccessToken({ userId, username, displayName }) {
  return jwt.sign({ sub: userId, username, displayName }, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTokenTtl,
    keyid: config.auth.jwtKeyId,
  });
}

// Verifies the signature (against the currently configured JWT_SECRET) and
// separately checks the token's `kid` header matches the currently
// configured JWT_KEY_ID. A rotated secret already invalidates the signature
// on its own; the kid check additionally catches the narrower
// misconfiguration where JWT_KEY_ID was bumped without actually rotating
// the secret, and keeps every rejection predictable and inspectable rather
// than a generic "bad signature" (Section 3, Secrets & Configuration).
export function verifyAccessToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.auth.jwtSecret, { complete: true });
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  if (decoded.header.kid !== config.auth.jwtKeyId) {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  return {
    userId: decoded.payload.sub,
    username: decoded.payload.username,
    displayName: decoded.payload.displayName,
    exp: decoded.payload.exp,
  };
}
