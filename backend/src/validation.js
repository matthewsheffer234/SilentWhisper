import { ValidationError } from './errors.js';
import { config } from './config.js';

// Server-side validation for everything crossing the API boundary
// (PROJECT_PLAN.md Section 3, Input Handling & Injection Prevention) —
// malformed input gets a 400 here, never passed through to the database.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exported as a source fragment (not just the compiled RegExp) so
// services/taskParser.js's owner-token capture group can reuse the exact
// same character class/length bound instead of re-typing it — a future
// change to username rules can't silently desync the two (FEATURE_REQUEST.md
// entry 3).
export const USERNAME_PATTERN_SOURCE = '[a-zA-Z0-9_.-]{3,50}';
const USERNAME_RE = new RegExp(`^${USERNAME_PATTERN_SOURCE}$`);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CHANNEL_TYPES = ['PUBLIC', 'PRIVATE', 'DIRECT', 'GROUP_DM'];
export const CREATABLE_CHANNEL_TYPES = ['PUBLIC', 'PRIVATE'];
// Roles a caller may *assign* to someone else via the invite/role-change/
// admin-create-user endpoints. OWNER is deliberately excluded — it's
// structurally unique per workspace (guaranteed by migration 0012) and, in
// this slice, never directly assignable at all; there is no
// transfer-ownership endpoint yet (FEATURE_REQUEST.md entry 1, slice 1).
export const ASSIGNABLE_WORKSPACE_ROLES = ['MANAGER', 'MEMBER'];

// Org membership roles a caller may assign via org invitation/direct-add/
// role-change endpoints (slice 2). Unlike ASSIGNABLE_WORKSPACE_ROLES,
// ORG_ADMIN is assignable here — organizations have no OWNER-equivalent
// uniqueness invariant (FEATURE_REQUEST.md entry 1's locked-in decision:
// "no 'every org needs ≥1 admin' invariant is enforced"), so there's no
// role to structurally exclude the way OWNER is excluded above.
export const ASSIGNABLE_ORG_ROLES = ['ORG_ADMIN', 'ORG_MEMBER'];

export const INVITATION_SCOPE_TYPES = ['ORGANIZATION', 'WORKSPACE'];

// Self-service workspace subscription (FEATURE_REQUEST.md) — same values
// and spirit as CHANNEL_TYPES' PUBLIC/PRIVATE distinction, one level up.
// DISCOVERABLE (renamed from PUBLIC in migration 0012, FEATURE_REQUEST.md
// entry 1) to match the enterprise-authz design's own vocabulary.
export const WORKSPACE_VISIBILITY = ['DISCOVERABLE', 'PRIVATE'];

// Matches messages.content being TEXT (unbounded in Postgres) but bounded
// at the application layer per Section 3 — also bounds audit payload size
// and LLM prompt size once Phase 4 lands.
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_NAME_LENGTH = 100; // workspaces.name / channels.name are VARCHAR(100)
export const MAX_USERNAME_LENGTH = 50; // users.username is VARCHAR(50)
export const MAX_EMAIL_LENGTH = 255; // users.email is VARCHAR(255)
export const MAX_DISPLAY_NAME_LENGTH = 100; // users.display_name is VARCHAR(100)
// Security.md (2026-07-15, LOW: "Group DM Creation Allows Unbounded Member
// Arrays") — a product-level cap, not a schema constraint; bounds the
// worst-case whereIn/insert size an authenticated caller can force.
export const MAX_GROUP_DM_MEMBERS = 20;

export function assertUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`${label} must be a valid UUID`);
  }
  return value;
}

export function assertUsername(value) {
  if (typeof value !== 'string' || !USERNAME_RE.test(value) || value.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(
      `username must be 3-${MAX_USERNAME_LENGTH} characters (letters, numbers, ".", "_", "-")`,
    );
  }
  return value;
}

export function assertEmail(value) {
  if (typeof value !== 'string' || !EMAIL_RE.test(value) || value.length > MAX_EMAIL_LENGTH) {
    throw new ValidationError('email must be a valid email address');
  }
  return value;
}

export function assertName(value, label = 'name') {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`${label} must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return value;
}

// Mirrors assertUsername's length/non-empty checks but permits spaces/mixed
// case/punctuation — a display name is not a login handle
// (FEATURE_REQUEST.md's "display names settable in the admin
// account-creation worksheet" entry).
export function assertDisplayName(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError(`displayName must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  return value;
}

export function assertMessageContent(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('content must be a non-empty string');
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`content must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  return value;
}

export function assertEnum(value, allowed, label = 'value') {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

// Generic bounded-scalar validators, added for Phase 4's admin-editable LLM
// settings (PROJECT_PLAN.md Section 2, Configurable LLM Provider Settings)
// but equally applicable to any future numeric/boolean config surface.
export function assertBoundedInt(value, { min, max }, label = 'value') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function assertBoundedNumber(value, { min, max }, label = 'value') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function assertBoolean(value, label = 'value') {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${label} must be a boolean`);
  }
  return value;
}

// Generic building block: only checks the value is a syntactically valid,
// non-empty http(s) URL. On its own this says nothing about whether the
// *target* is trustworthy — see assertAllowedLlmUrl below, which layers an
// origin allowlist on top of this for the one caller (LLM baseUrl) where
// the target matters.
export function assertHttpUrl(value, label = 'value') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new ValidationError(`${label} must be a non-empty URL string`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${label} must use http or https`);
  }
  return value;
}

// Deployment-controlled allowlist (Security.md, 2026-07-15, MEDIUM: "LLM
// Base URL Allows Backend-Side SSRF and Global AI DoS"). Read once at
// module load from config.js's ALLOWED_LLM_ORIGINS/LLM_BASE_URL-derived
// default, not per-call — this is operator/deployment config, never
// user-supplied.
const ALLOWED_LLM_ORIGINS = new Set(config.llm.allowedLlmOrigins);

// `baseUrl` is admin-editable via PATCH /api/ai/settings (Section 4,
// Runtime Configuration), unlike LLM_BASE_URL itself, which is trusted
// operator-set deployment config. That makes it attacker-reachable input:
// without this check, a compromised or over-privileged admin session could
// point the backend at loopback, link-local, or private-network targets as
// an SSRF primitive, or break AI/search globally by pointing it at a
// blackhole (Security.md's exploit scenario for this finding). Only an
// explicitly allowlisted origin is accepted; the return value is
// normalized to just that origin, discarding any path/query the caller
// supplied, since only the origin is ever meaningful for this setting.
export function assertAllowedLlmUrl(value, label = 'baseUrl') {
  const parsed = new URL(assertHttpUrl(value, label));
  if (!ALLOWED_LLM_ORIGINS.has(parsed.origin)) {
    throw new ValidationError(`${label} is not an approved LLM provider origin`);
  }
  return parsed.origin;
}

export function assertShortString(value, { maxLength }, label = 'value') {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ValidationError(`${label} must be 1-${maxLength} characters`);
  }
  return value;
}

// Semantic search (FEATURE_REQUEST.md entry 1) — bounds the query text sent
// into the embedding provider, same "reject malformed/oversized input with a
// 400 before it reaches the database or an upstream call" instinct as
// MAX_MESSAGE_LENGTH.
export const MAX_SEARCH_QUERY_LENGTH = 2000;

export function assertSearchQuery(value) {
  return assertShortString(value, { maxLength: MAX_SEARCH_QUERY_LENGTH }, 'query');
}

// Pagination for message history (PROJECT_PLAN.md Section 2, Scalability
// Target: "Paginate all message history queries server-side; never return
// unbounded result sets"). `before` is an ISO timestamp cursor, not an
// offset, matching idx_messages_channel_date's (channel_id, created_at DESC).
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export function parsePagination(query) {
  let limit = DEFAULT_PAGE_LIMIT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
  }

  let before = null;
  if (query.before !== undefined) {
    before = new Date(query.before);
    if (Number.isNaN(before.getTime())) {
      throw new ValidationError('before must be a valid ISO timestamp');
    }
  }

  return { limit, before };
}

// Offset-based pagination for bounded admin list endpoints (FEATURE_REQUEST.md
// entry 4) — a deliberate departure from parsePagination's cursor-by-timestamp
// shape above, which fits unbounded, reverse-chronological message history.
// Admin lists are bounded by total user/workspace count and browsed in a
// stable (non-time-based) order today, so plain limit/offset fits better:
// simple, and OFFSET scanning even several thousand admin-list rows is
// trivially fast, unlike scanning millions of messages. Shares
// DEFAULT_PAGE_LIMIT/MAX_PAGE_LIMIT with parsePagination rather than
// inventing a second set of bounds.
export function parseOffsetPagination(query) {
  let limit = DEFAULT_PAGE_LIMIT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
  }

  let offset = 0;
  if (query.offset !== undefined) {
    offset = Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }
  }

  return { limit, offset };
}
