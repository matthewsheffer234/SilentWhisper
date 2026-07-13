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
// must never be re-scanned for bold/italic/mention syntax inside it), then
// bold, then italic, then mentions. This mirrors this app's other "silently
// resolve to nothing" instinct (mentions already do this for a
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
// Same shape/length bound as the backend's mention regex (mentionService.js)
// — a purely visual highlight, not a re-validation of who was actually
// notified (an @mention of a nonexistent or non-member username still
// renders highlighted here even though the backend silently notified
// nobody, matching the existence-hiding convention: this view has no way to
// know which mentions resolved).
const MENTION_RE = /@[a-zA-Z0-9_.-]{3,50}/g;

const styles = {
  mention: { color: 'var(--brg)', fontWeight: 700 },
  link: { color: 'var(--brg)', textDecoration: 'underline' },
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

function mdLinkToNode([, label, url], nextKey) {
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
    <a key={nextKey()} href={url} target="_blank" rel="noopener noreferrer" style={styles.link}>
      {label}
    </a>
  );
}

function autolinkToNode([url], nextKey) {
  // The regex only ever matches an explicit http(s):// prefix, so this
  // should always be safe — checked anyway for defense in depth rather than
  // trusting the regex alone, same instinct as everywhere else untrusted
  // content meets a rendered href.
  if (!isSafeHttpUrl(url)) return null;
  return (
    <a key={nextKey()} href={url} target="_blank" rel="noopener noreferrer" style={styles.link}>
      {url}
    </a>
  );
}

// Bold/italic content gets one more pass applied to it — mentions only,
// not links/bold/italic again — before being wrapped, so "**hey @bob**"
// still highlights the mention. This is the one level of nesting the design
// calls for ("a mention inside bold ... should still highlight"), not
// general recursive re-parsing of everything inside everything. Unwraps a
// single-item result back to a bare string/node — keeps the common
// no-mention-inside case (the vast majority of bold/italic text) a plain
// string child instead of a length-1 array for no reason.
function processMentionsWithin(text, nextKey) {
  const result = applyPass([text], MENTION_RE, mentionToNode, nextKey);
  return result.length === 1 ? result[0] : result;
}

function boldToNode([, content], nextKey) {
  return <strong key={nextKey()}>{processMentionsWithin(content, nextKey)}</strong>;
}

function italicToNode([, content], nextKey) {
  return <em key={nextKey()}>{processMentionsWithin(content, nextKey)}</em>;
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

function boldUnderscoreToNode(match, nextKey) {
  if (BARE_IDENTIFIER_RE.test(match[1])) return null;
  return boldToNode(match, nextKey);
}

function italicUnderscoreToNode(match, nextKey) {
  if (BARE_IDENTIFIER_RE.test(match[1])) return null;
  return italicToNode(match, nextKey);
}

function mentionToNode([text], nextKey) {
  return (
    <span key={nextKey()} style={styles.mention}>
      {text}
    </span>
  );
}

export function renderMessageContent(content) {
  let keyCounter = 0;
  const nextKey = () => keyCounter++;

  let nodes = [content];
  nodes = applyPass(nodes, MD_LINK_RE, mdLinkToNode, nextKey);
  nodes = applyPass(nodes, AUTOLINK_RE, autolinkToNode, nextKey);
  nodes = applyPass(nodes, BOLD_STAR_RE, boldToNode, nextKey);
  nodes = applyPass(nodes, BOLD_UNDERSCORE_RE, boldUnderscoreToNode, nextKey);
  nodes = applyPass(nodes, ITALIC_STAR_RE, italicToNode, nextKey);
  nodes = applyPass(nodes, ITALIC_UNDERSCORE_RE, italicUnderscoreToNode, nextKey);
  nodes = applyPass(nodes, MENTION_RE, mentionToNode, nextKey);
  return nodes;
}
