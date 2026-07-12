import { ValidationError } from './errors.js';

// Server-side validation for everything crossing the API boundary
// (PROJECT_PLAN.md Section 3, Input Handling & Injection Prevention) —
// malformed input gets a 400 here, never passed through to the database.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,50}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CHANNEL_TYPES = ['PUBLIC', 'PRIVATE', 'DIRECT', 'GROUP_DM'];
export const CREATABLE_CHANNEL_TYPES = ['PUBLIC', 'PRIVATE'];
export const WORKSPACE_ROLES = ['ADMIN', 'MEMBER'];

// Matches messages.content being TEXT (unbounded in Postgres) but bounded
// at the application layer per Section 3 — also bounds audit payload size
// and LLM prompt size once Phase 4 lands.
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_NAME_LENGTH = 100; // workspaces.name / channels.name are VARCHAR(100)
export const MAX_USERNAME_LENGTH = 50; // users.username is VARCHAR(50)
export const MAX_EMAIL_LENGTH = 255; // users.email is VARCHAR(255)

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

// Pagination for message history (PROJECT_PLAN.md Section 2, Scalability
// Target: "Paginate all message history queries server-side; never return
// unbounded result sets"). `before` is an ISO timestamp cursor, not an
// offset, matching idx_messages_channel_date's (channel_id, created_at DESC).
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

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
