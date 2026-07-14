import crypto from 'node:crypto';

// Invitation tokens are opaque random values; only a SHA-256 hash is ever
// stored, the exact same convention refreshTokens.js already establishes
// for refresh_tokens ("only a hash of the token ... revocation is a row
// update, not a secret-recovery risk," PROJECT_PLAN.md Section 4) — same
// algorithm and entropy, factored out here since both the org/workspace
// invitation-creation routes and invitations.js's redemption routes need
// it, without either reaching into the other's internals.

export function generateInvitationToken() {
  return crypto.randomBytes(48).toString('hex');
}

export function hashInvitationToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// A fixed product decision, not an operational/deployment knob the way
// config.auth.refreshTokenTtlMs is — not env-configurable. Promote into
// config.auth alongside it if this ever needs to be admin-tunable.
export const INVITATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
