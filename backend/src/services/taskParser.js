import { config } from '../config.js';
import { USERNAME_PATTERN_SOURCE } from '../validation.js';

// FEATURE_REQUEST.md entry 3: Obsidian-style inline checkbox tasks,
// tokenized deterministically from `messages.content` itself — no model
// call, no second system of record to drift from channel content. This is
// the one canonical tokenizer; frontend/src/markdown.jsx mirrors it line for
// line (see that file's own cross-reference comment), since /backend and
// /frontend are separate npm packages with no shared workspace today.
// docs/task-tokenizer-fixtures.json is read by both sides' test suites as
// the guardrail against the two quietly drifting apart — if the regex ever
// changes here, it must change there too, and the fixture file is what
// proves it stayed in sync.
//
// Terminology: the Markdown token's *key* (`[owner:: @user]` by default) is
// a configurable alias (config.tasks.ownerTokenAlias / TASK_OWNER_TOKEN_ALIAS)
// — a deployment can rename the bracket syntax without a code change. The
// *parsed*/internal field is always `owner`, regardless of what the token
// itself is spelled as.

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `[ xX]` — a literal space, not `[\sxX]` — is what "an Obsidian-style
// checkbox" actually means; `\s` would also accept a stray tab/newline
// inside the capture as "checked." The owner group reuses
// USERNAME_PATTERN_SOURCE (validation.js) rather than re-typing the
// character class/length bound, so a future username-rule change can't
// silently desync the two. `gm` flags let matchAll walk every line of a
// multi-line message in one pass, each `^...$` pair confined to its own
// line — a match never crosses a newline since `.` doesn't match one.
export function buildTaskLineRegex(ownerTokenAlias) {
  const escapedAlias = escapeForRegex(ownerTokenAlias);
  return new RegExp(
    `^-\\s\\[([ xX])\\]\\s+(.*?)(?:\\s+\\[${escapedAlias}::\\s*@(${USERNAME_PATTERN_SOURCE})\\])?\\s*$`,
    'gm',
  );
}

// Pure/DB-free. Only lines matching the checkbox syntax count toward
// `index`; every other line is silently skipped — matching this codebase's
// "malformed/unrecognized syntax resolves to nothing" convention elsewhere
// (mentions, entities), not an error.
export function parseTasks(content, { ownerTokenAlias = config.tasks.ownerTokenAlias } = {}) {
  const regex = buildTaskLineRegex(ownerTokenAlias);
  const tasks = [];
  let index = 0;
  for (const match of String(content ?? '').matchAll(regex)) {
    tasks.push({
      index: index++,
      checked: match[1] !== ' ',
      text: match[2],
      owner: match[3] ?? null,
    });
  }
  return tasks;
}

// Returns the new content with only the target task line's checkbox
// character changed, or `null` if `index` is out of range for the current
// content — the caller 404s rather than guessing (e.g. the message was
// edited out from under a stale client, once message editing exists).
// Every other byte of the line (description, owner token, surrounding
// content) is carried through unchanged: the regex's own captured line
// start plus a fixed 3-character offset (`-`, one whitespace char, `[`)
// lands exactly on the checkbox mark, so this never re-serializes anything
// it didn't have to.
export function setTaskChecked(content, index, checked, { ownerTokenAlias = config.tasks.ownerTokenAlias } = {}) {
  const regex = buildTaskLineRegex(ownerTokenAlias);
  const source = String(content ?? '');

  let taskOrdinal = -1;
  let targetMatch = null;
  for (const match of source.matchAll(regex)) {
    taskOrdinal += 1;
    if (taskOrdinal === index) {
      targetMatch = match;
      break;
    }
  }
  if (!targetMatch) return null;

  const mark = checked ? 'x' : ' ';
  const checkboxCharIndex = targetMatch.index + 3; // "-" + "\s" + "[" precede the mark
  return source.slice(0, checkboxCharIndex) + mark + source.slice(checkboxCharIndex + 1);
}
