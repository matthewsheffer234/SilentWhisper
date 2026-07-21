// FEATURE_REQUEST.md's Basic Markdown formatting entry. `messages.content`
// stays raw text end to end (backend unchanged) — this is the single
// client-side rendering entry point, replacing ChannelView.jsx's old
// module-private `renderContentWithMentions`. A hand-rolled multi-pass
// tokenizer, not a markdown library + sanitizer (PROJECT_PLAN.md Section 3
// anticipated this feature and asked for an allow-list sanitizer if a full
// parser were used) — bold/italic/links/mentions is a small enough surface
// that pulling in a CommonMark parser plus a sanitizer for arbitrary HTML
// would be disproportionate, and reopens a real, recurring bug class
// (sanitizer allow-list bypasses) for content that never needs arbitrary
// HTML. Every pass returns plain React children (strings/elements), never
// an HTML string — dangerouslySetInnerHTML is never used.
//
// Passes run in a fixed order, each only re-scanning the plain-text
// segments left over from the one before it: links first (a URL's own text
// must never be re-scanned for bold/italic/entity/mention syntax inside it),
// then bold, then italic, then entity tags, then mentions. This mirrors this
// app's other "silently resolve to nothing" instinct (mentions already do this for a
// non-existent username): malformed/unclosed syntax or an unsafe link
// scheme simply falls back to literal text for that token rather than
// erroring or consuming the rest of the message hunting for a closer that
// isn't there.

// The URL group deliberately allows `)` inside it (not `[^\s)]+`) — a URL
// can legitimately contain its own parens (a Wikipedia-style
// `.../Foo_(disambiguation)`, or, for a case this app specifically cares
// about, an XSS payload like `javascript:alert(1)`), and stopping at the
// *first* `)` truncates the captured URL and leaves the link syntax's real
// closing paren behind as a stray literal character. `[^\s]+` is greedy
// (can't cross the next whitespace boundary either way) and backtracks by
// one to satisfy the required trailing `\)`, so it lands on the *last* `)`
// before whitespace — correctly capturing "javascript:alert(1)" whole
// rather than "javascript:alert(1" plus a dangling ")".
const MD_LINK_RE = /\[([^\]\n]+)\]\(([^\s]+)\)/g;
const AUTOLINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const BOLD_STAR_RE = /\*\*([^\n]+?)\*\*/g;
// `__` and `_` need a word-boundary guard that `**`/`*` don't: asterisks
// essentially never appear inside a normal identifier, but underscores are
// everywhere in this app's own likely chat content — snake_case names,
// Python dunders like __init__. Without the guard, "check my_file_name.py"
// or "call __init__ then __del__" would silently turn into italic/bold
// fragments around a word nobody meant to emphasize. `(?<!\w)`/`(?!\w)`
// require a non-word character (or start/end of string) immediately
// outside the delimiter pair, same idea CommonMark itself uses for `_`.
const BOLD_UNDERSCORE_RE = /(?<!\w)__([^\n]+?)__(?!\w)/g;
const ITALIC_STAR_RE = /\*([^\n*]+?)\*/g;
const ITALIC_UNDERSCORE_RE = /(?<!\w)_([^\n_]+?)_(?!\w)/g;
const ENTITY_RE = /\[\[([^\[\]]{1,255})\]\]/g;
// Same shape/length bound as the backend's mention regex (mentionService.js)
// — a purely visual highlight, not a re-validation of who was actually
// notified (an @mention of a nonexistent or non-member username still
// renders highlighted here even though the backend silently notified
// nobody, matching the existence-hiding convention: this view has no way to
// know which mentions resolved).
const MENTION_RE = /@[a-zA-Z0-9_.-]{3,50}/g;

// FEATURE_REQUEST.md entry 3: inline Markdown checkbox tasks. This is the
// frontend mirror of backend/src/services/taskParser.js's tokenizer — kept
// in sync via docs/task-tokenizer-fixtures.json, which both sides' test
// suites run through their own implementation as a guardrail against the
// two quietly drifting apart (/backend and /frontend are separate npm
// packages with no shared workspace). If this regex ever changes, that
// file's own tokenizer must change identically.
//
// The owner token's *key* (`[owner:: @user]` by default) is a configurable
// alias, mirroring config.tasks.ownerTokenAlias/TASK_OWNER_TOKEN_ALIAS on
// the backend via VITE_TASK_OWNER_TOKEN_ALIAS (baked in at build time, like
// VITE_API_URL/VITE_WS_URL) — there is no runtime handshake between the two,
// so a deployment changing one without the other silently desyncs parsing.
const TASK_OWNER_TOKEN_ALIAS = (import.meta.env.VITE_TASK_OWNER_TOKEN_ALIAS || 'owner').trim();

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `[ xX]` — a literal space, not `[\sxX]` — matches what an Obsidian-style
// checkbox actually means. The owner group's username bound
// (`{3,50}`/`[a-zA-Z0-9_.-]`) is the same literal character class MENTION_RE
// above already duplicates from the backend's USERNAME_RE, not a new
// duplication introduced here.
function buildTaskLineRegex() {
  const escapedAlias = escapeForRegex(TASK_OWNER_TOKEN_ALIAS);
  return new RegExp(`^-\\s\\[([ xX])\\]\\s+(.*?)(?:\\s+\\[${escapedAlias}::\\s*@([a-zA-Z0-9_.-]{3,50})\\])?\\s*$`, 'gm');
}

// Pure, render-free mirror of backend/src/services/taskParser.js's
// parseTasks — same {index, checked, text, owner} shape, same "only lines
// matching the checkbox syntax count toward index" rule. Exported
// specifically so markdown.test.jsx can run docs/task-tokenizer-fixtures.json
// through this exact function and compare against the same fixture list
// taskParser.test.js runs on the backend side — the parity guardrail
// FEATURE_REQUEST.md entry 3 calls for. applyTaskPass below re-derives
// positions itself (it needs match.index/length for splitting, which would
// just be dead weight on every other caller of this function), so this
// isn't wired into rendering directly.
export function parseTaskLines(content) {
  const regex = buildTaskLineRegex();
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

// FEATURE_REQUEST.md's iMessage-style bubble layout entry: a "mine" bubble
// fills its background with `var(--brg)` — the same color `mention`/`link`
// use for their *text*, which would be unreadable green-on-green inside
// one. `--item-active-fg` (`#fff` in both themes) is the same token pair
// the bubble entry's own "mine" fill already reuses for the active sidebar
// row, not a new one invented here; a fontWeight/underline treatment
// substitutes for the color-only differentiation that isn't available
// against a same-colored background.
const styles = {
  mention: { color: 'var(--brg)', fontWeight: 700 },
  mentionOnMine: { color: 'var(--item-active-fg)', fontWeight: 700, textDecoration: 'underline' },
  entity: {
    color: 'var(--brg)',
    background: 'var(--surface-alt)',
    fontWeight: 700,
    borderRadius: 6,
    padding: '1px 5px',
  },
  entityOnMine: {
    color: 'var(--item-active-fg)',
    background: 'transparent',
    fontWeight: 700,
    textDecoration: 'underline',
    border: '1px solid currentColor',
    borderRadius: 6,
    padding: '1px 5px',
  },
  entityButton: {
    border: 'none',
    font: 'inherit',
    cursor: 'pointer',
  },
  link: { color: 'var(--brg)', textDecoration: 'underline' },
  linkOnMine: { color: 'var(--item-active-fg)', textDecoration: 'underline', fontWeight: 700 },
  // FEATURE_REQUEST.md entry 3, item 5: checkbox hit target 44×44px minimum
  // — same literal precedent as ChannelView.jsx's detailsButton
  // (minWidth/minHeight: 44), not a new convention. The visible glyph is
  // smaller (18px) and centered inside the full hit target.
  taskRow: { display: 'flex', alignItems: 'flex-start', gap: 4 },
  taskCheckboxButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    padding: 0,
    flexShrink: 0,
  },
  taskCheckboxGlyph: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: '2px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.1s, border-color 0.1s',
  },
  taskCheckboxGlyphChecked: { background: 'var(--brg)', borderColor: 'var(--brg)' },
  taskCheckMark: { color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: 1 },
  taskText: { paddingTop: 11 },
  taskTextChecked: { color: 'var(--text-3)', textDecoration: 'line-through' },
  taskOwner: { marginLeft: 6 },
};

// Not `dangerouslySetInnerHTML`, but a rendered `<a href>` is still a live
// XSS vector on its own — a `javascript:alert(1)`-style href executes on
// click regardless of how the element was constructed. Mirrors
// backend/src/validation.js's assertHttpUrl scheme check, applied
// client-side to markdown link targets.
function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Applies one regex pass over an array of (string | ReactNode) nodes,
// leaving already-tokenized elements from earlier passes untouched and only
// re-scanning the plain-text segments — the mechanism behind "each pass
// only re-scans what's left over from the previous one." `nextKey` is
// threaded through as the counter *function* itself, not a pre-computed
// value — bold/italic need to call it more than once per match (one key for
// their own element, plus however many a nested mention pass over their own
// captured text consumes), not exactly one.
function applyPass(nodes, regex, toNode, nextKey) {
  const result = [];
  for (const node of nodes) {
    if (typeof node !== 'string') {
      result.push(node);
      continue;
    }
    let lastIndex = 0;
    regex.lastIndex = 0;
    let match = regex.exec(node);
    while (match) {
      const rendered = toNode(match, nextKey);
      if (rendered === null) {
        // Not treated as a real token after all — leave it as literal text
        // by not consuming it, and resume scanning right after the match
        // start so a rejected match can't loop forever on the same spot.
        regex.lastIndex = match.index + 1;
        match = regex.exec(node);
        continue;
      }
      if (match.index > lastIndex) result.push(node.slice(lastIndex, match.index));
      result.push(rendered);
      lastIndex = match.index + match[0].length;
      regex.lastIndex = lastIndex;
      match = regex.exec(node);
    }
    if (lastIndex < node.length) result.push(node.slice(lastIndex));
  }
  return result;
}

function mdLinkToNode([, label, url], nextKey, linkStyle) {
  // A well-formed `[label](url)` pointing at an unsafe scheme still renders
  // as its label text (consuming the token so raw `[…](…)` source never
  // leaks through), just not as a clickable anchor — same "silently resolve
  // to nothing" pattern as everything else here, not a hard error. Link
  // labels are never re-scanned for mentions — only bold/italic content is
  // (see boldToNode/italicToNode) — matching the design's explicit "a
  // mention-shaped string inside a URL should not be independently
  // re-parsed."
  if (!isSafeHttpUrl(url)) return label;
  return (
    <a key={nextKey()} href={url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
      {label}
    </a>
  );
}

function autolinkToNode([url], nextKey, linkStyle) {
  // The regex only ever matches an explicit http(s):// prefix, so this
  // should always be safe — checked anyway for defense in depth rather than
  // trusting the regex alone, same instinct as everywhere else untrusted
  // content meets a rendered href.
  if (!isSafeHttpUrl(url)) return null;
  return (
    <a key={nextKey()} href={url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
      {url}
    </a>
  );
}

function mentionToNode([text], nextKey, mentionStyle) {
  return (
    <span key={nextKey()} style={mentionStyle}>
      {text}
    </span>
  );
}

function entityToNode([text, label], nextKey, entityStyle, onEntityClick) {
  if (onEntityClick) {
    return (
      <button
        key={nextKey()}
        type="button"
        style={{ ...styles.entityButton, ...entityStyle }}
        onClick={() => onEntityClick(label)}
        aria-label={`Open entity ${label}`}
      >
        {text}
      </button>
    );
  }
  return (
    <span key={nextKey()} style={entityStyle}>
      {text}
    </span>
  );
}

// Bold/italic content gets one more highlight pass applied to it — entities
// and mentions only, not links/bold/italic again — before being wrapped, so
// "**hey @bob about [[Server Alpha]]**" still highlights the inline tokens.
// This is one level of nesting, not general recursive re-parsing of
// everything inside everything.
function processHighlightsWithin(text, nextKey, { mentionStyle, entityStyle, onEntityClick }) {
  let result = applyPass([text], ENTITY_RE, (m, nk) => entityToNode(m, nk, entityStyle, onEntityClick), nextKey);
  result = applyPass(result, MENTION_RE, (m, nk) => mentionToNode(m, nk, mentionStyle), nextKey);
  return result.length === 1 ? result[0] : result;
}

function boldToNode([, content], nextKey, highlightOptions) {
  return <strong key={nextKey()}>{processHighlightsWithin(content, nextKey, highlightOptions)}</strong>;
}

function italicToNode([, content], nextKey, highlightOptions) {
  return <em key={nextKey()}>{processHighlightsWithin(content, nextKey, highlightOptions)}</em>;
}

// The outer (?<!\w)/(?!\w) guard on BOLD_UNDERSCORE_RE/ITALIC_UNDERSCORE_RE
// only rejects delimiters directly touching a word character *outside* the
// pair (catches snake_case: "my_file_name" never even starts a match, since
// the first `_` is preceded by `y`). It does nothing for "call __init__
// then __del__" — there, both `__`s bounding "init" are correctly flanked
// by spaces on their *outside*, so the outer guard has nothing to object
// to; the token is genuinely ambiguous with real emphasis using the exact
// same shape. Resolving that properly needs CommonMark's full delimiter-
// flanking algorithm, which is more than "basic" scope calls for — instead,
// reject specifically when the captured content is a single bare
// identifier with no internal whitespace (`init`, `del`), which is what a
// dunder's content always looks like and genuine multi-word emphasis never
// does. The one real cost: a single word deliberately bolded/italicized
// with underscores alone ("__important__") also gets rejected — asterisks
// (`**important**`/`*important*`) remain available for that case and don't
// share this ambiguity, so nothing is actually unreachable, just steered
// to the delimiter that doesn't collide with code-identifier syntax.
const BARE_IDENTIFIER_RE = /^\w+$/;

function boldUnderscoreToNode(match, nextKey, highlightOptions) {
  if (BARE_IDENTIFIER_RE.test(match[1])) return null;
  return boldToNode(match, nextKey, highlightOptions);
}

function italicUnderscoreToNode(match, nextKey, highlightOptions) {
  if (BARE_IDENTIFIER_RE.test(match[1])) return null;
  return italicToNode(match, nextKey, highlightOptions);
}

// Factored out of renderMessageContent so applyTaskPass below can run this
// exact same sequence over a task line's own description text (recursive,
// one level — "so [[Entity]] links, @mentions, bold/italic inside a task
// description keep working," FEATURE_REQUEST.md entry 3) without
// duplicating the pass order.
function applyInlinePasses(nodes, nextKey, { linkStyle, highlightOptions, entityStyle, mentionStyle, onEntityClick }) {
  let result = applyPass(nodes, MD_LINK_RE, (m, nk) => mdLinkToNode(m, nk, linkStyle), nextKey);
  result = applyPass(result, AUTOLINK_RE, (m, nk) => autolinkToNode(m, nk, linkStyle), nextKey);
  result = applyPass(result, BOLD_STAR_RE, (m, nk) => boldToNode(m, nk, highlightOptions), nextKey);
  result = applyPass(result, BOLD_UNDERSCORE_RE, (m, nk) => boldUnderscoreToNode(m, nk, highlightOptions), nextKey);
  result = applyPass(result, ITALIC_STAR_RE, (m, nk) => italicToNode(m, nk, highlightOptions), nextKey);
  result = applyPass(result, ITALIC_UNDERSCORE_RE, (m, nk) => italicUnderscoreToNode(m, nk, highlightOptions), nextKey);
  result = applyPass(result, ENTITY_RE, (m, nk) => entityToNode(m, nk, entityStyle, onEntityClick), nextKey);
  result = applyPass(result, MENTION_RE, (m, nk) => mentionToNode(m, nk, mentionStyle), nextKey);
  return result;
}

// Exported so WorkspaceHome.jsx's task dashboard can reuse the exact same
// checkbox visual/hit-target rather than a second, drifting copy — the
// dashboard's rows aren't rendered through renderMessageContent itself
// (they're a flat list of already-parsed task rows from the API, not raw
// message content), but the checkbox affordance should look and behave
// identically wherever a task appears.
// Finding 8, docs/reviews/security-performance-review-2026-07-20.md:
// `disabled` used to be inferred only from `!onToggle` — whether a handler
// exists at all, not whether a toggle for *this specific* checkbox is
// currently in flight. The caller (ChatShell.jsx) now passes `disabled`
// explicitly while its own optimistic request for this exact checkbox is
// outstanding, so a second click can't race the first one.
export function TaskCheckbox({ checked, onToggle, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={!onToggle || disabled}
      onClick={onToggle ? () => onToggle(!checked) : undefined}
      style={{ ...styles.taskCheckboxButton, cursor: onToggle && !disabled ? 'pointer' : 'default' }}
      aria-label={checked ? 'Mark task as not done' : 'Mark task as done'}
    >
      <span style={{ ...styles.taskCheckboxGlyph, ...(checked ? styles.taskCheckboxGlyphChecked : {}) }}>
        {checked && (
          <span aria-hidden="true" style={styles.taskCheckMark}>
            ✓
          </span>
        )}
      </span>
    </button>
  );
}

function TaskLineRow({ checked, owner, onToggle, disabled, mentionStyle, children }) {
  return (
    <div style={styles.taskRow}>
      <TaskCheckbox checked={checked} onToggle={onToggle} disabled={disabled} />
      <span style={{ ...styles.taskText, ...(checked ? styles.taskTextChecked : {}) }}>
        {children}
        {owner && <span style={{ ...mentionStyle, ...styles.taskOwner }}>@{owner}</span>}
      </span>
    </div>
  );
}

// First pass over the raw content, line by line, before any of the other
// passes (FEATURE_REQUEST.md entry 3, item 5) — task-line syntax is
// line-anchored (`^-\s\[...\]...$`), so it has to be resolved before bold/
// italic/link/entity/mention passes, which operate on arbitrary substrings
// and would otherwise never see the line boundaries this depends on.
//
// Adjacent newlines directly touching a matched task line are trimmed from
// the surrounding plain-text segments (not from the match itself) — the
// checkbox row renders as its own block-level element, which already forces
// a line break, so keeping the newline character too would double it into a
// blank line above/below every task row.
// Finding 8: `taskOverrides` is a plain `{ "<messageId>:<taskIndex>": checked
// }` map — the presence of a key means that specific checkbox has an
// optimistic toggle in flight (ChatShell.jsx adds the key right before
// awaiting the request and removes it in a `finally`, whether the request
// succeeds or fails). While a key is present, its `checked` value overrides
// whatever the raw content currently parses to, and the row renders
// disabled — the same "trust the optimistic value, block a second click"
// shape `handleSend`'s own `pending: true` messages already establish.
function applyTaskPass(content, nextKey, { onToggleTask, messageId, taskOverrides, inlineOptions }) {
  const regex = buildTaskLineRegex();
  const matches = [...content.matchAll(regex)];
  if (matches.length === 0) return [content];

  const result = [];
  let cursor = 0;
  let taskOrdinal = 0;
  for (const match of matches) {
    let before = content.slice(cursor, match.index);
    if (before.endsWith('\n')) before = before.slice(0, -1);
    if (before) result.push(before);

    const currentTaskIndex = taskOrdinal;
    const overrideKey = `${messageId}:${currentTaskIndex}`;
    const hasOverride = Boolean(taskOverrides) && Object.prototype.hasOwnProperty.call(taskOverrides, overrideKey);
    const checked = hasOverride ? taskOverrides[overrideKey] : match[1] !== ' ';
    const owner = match[3] ?? null;
    const descriptionNodes = applyInlinePasses([match[2]], nextKey, inlineOptions);
    result.push(
      <TaskLineRow
        key={nextKey()}
        checked={checked}
        disabled={hasOverride}
        owner={owner}
        mentionStyle={inlineOptions.mentionStyle}
        onToggle={onToggleTask ? (nextChecked) => onToggleTask(messageId, currentTaskIndex, nextChecked) : undefined}
      >
        {descriptionNodes}
      </TaskLineRow>,
    );

    taskOrdinal += 1;
    cursor = match.index + match[0].length;
  }

  let after = content.slice(cursor);
  if (after.startsWith('\n')) after = after.slice(1);
  if (after) result.push(after);
  return result;
}

// `variant: 'mine'` is the one caller-facing option (FEATURE_REQUEST.md's
// bubble-layout entry) — content rendered inside a "mine" filled bubble
// needs mention/link styling that stays legible against that same-colored
// background, everything else (bold/italic wrapping, tokenization order)
// is identical regardless of variant. `onToggleTask`/`messageId`
// (FEATURE_REQUEST.md entry 3) are optional — omitted entirely, a task line
// still renders as a checked/unchecked row, just not an interactive one
// (e.g. inside a context with no toggle affordance).
export function renderMessageContent(content, { variant, onEntityClick, onToggleTask, messageId, taskOverrides } = {}) {
  let keyCounter = 0;
  const nextKey = () => keyCounter++;
  const mentionStyle = variant === 'mine' ? styles.mentionOnMine : styles.mention;
  const entityStyle = variant === 'mine' ? styles.entityOnMine : styles.entity;
  const linkStyle = variant === 'mine' ? styles.linkOnMine : styles.link;
  const highlightOptions = { mentionStyle, entityStyle, onEntityClick };
  const inlineOptions = { linkStyle, highlightOptions, entityStyle, mentionStyle, onEntityClick };

  let nodes = applyTaskPass(content, nextKey, { onToggleTask, messageId, taskOverrides, inlineOptions });
  nodes = applyInlinePasses(nodes, nextKey, inlineOptions);
  return nodes;
}
