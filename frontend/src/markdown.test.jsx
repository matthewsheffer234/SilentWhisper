import { describe, test, expect } from 'vitest';
import { renderMessageContent } from './markdown.jsx';

// FEATURE_REQUEST.md's Basic Markdown formatting entry: "unit tests for the
// tokenizer covering each token type." Inspects the returned React element
// objects directly (`.type`/`.props`) rather than rendering to a DOM — this
// is testing the tokenizer's own logic, not integration with a browser,
// which the e2e suite already covers separately (sending a real message and
// asserting the rendered feed contains real <strong>/<em>/<a> elements).

function elementsOfType(nodes, type) {
  return nodes.filter((n) => typeof n === 'object' && n !== null && n.type === type);
}

describe('bold', () => {
  test('** renders <strong>', () => {
    const nodes = renderMessageContent('this is **bold** text');
    const [strong] = elementsOfType(nodes, 'strong');
    expect(strong.props.children).toBe('bold');
  });

  test('__ renders <strong> for multi-word content', () => {
    // Single-word underscore bold ("__bold__") is deliberately rejected —
    // see the bare-identifier-dunder test below and markdown.jsx's own
    // comment on why; multi-word content isn't ambiguous with a code
    // identifier and still works.
    const nodes = renderMessageContent('this is __quite bold__ text');
    const [strong] = elementsOfType(nodes, 'strong');
    expect(strong.props.children).toBe('quite bold');
  });

  test('__ does not trigger inside a Python dunder like __init__', () => {
    const nodes = renderMessageContent('call __init__ then __del__');
    expect(elementsOfType(nodes, 'strong')).toHaveLength(0);
    expect(nodes.join('')).toBe('call __init__ then __del__');
  });
});

describe('italic', () => {
  test('* renders <em>', () => {
    const nodes = renderMessageContent('this is *italic* text');
    const [em] = elementsOfType(nodes, 'em');
    expect(em.props.children).toBe('italic');
  });

  test('_ renders <em> for multi-word content', () => {
    const nodes = renderMessageContent('this is _quite italic_ text');
    const [em] = elementsOfType(nodes, 'em');
    expect(em.props.children).toBe('quite italic');
  });

  test('single-word _ is rejected as indistinguishable from a code identifier', () => {
    const nodes = renderMessageContent('this is _italic_ text');
    expect(elementsOfType(nodes, 'em')).toHaveLength(0);
  });

  test('_ does not trigger inside a snake_case identifier', () => {
    const nodes = renderMessageContent('check my_file_name.py please');
    expect(elementsOfType(nodes, 'em')).toHaveLength(0);
    expect(nodes.join('')).toBe('check my_file_name.py please');
  });
});

describe('links', () => {
  test('markdown-syntax link renders a safe <a>', () => {
    const nodes = renderMessageContent('see [the docs](https://example.com/docs)');
    const [a] = elementsOfType(nodes, 'a');
    expect(a.props.href).toBe('https://example.com/docs');
    expect(a.props.children).toBe('the docs');
    expect(a.props.target).toBe('_blank');
    expect(a.props.rel).toBe('noopener noreferrer');
  });

  test('a URL containing its own internal parens is captured whole, not truncated at the first )', () => {
    const nodes = renderMessageContent('see [disambiguation](https://en.wikipedia.org/wiki/Foo_(disambiguation)) now');
    const [a] = elementsOfType(nodes, 'a');
    expect(a.props.href).toBe('https://en.wikipedia.org/wiki/Foo_(disambiguation)');
    // No stray leftover ")" left behind as its own literal text segment
    // from a match that stopped short of the real closing paren.
    const trailingText = nodes[nodes.length - 1];
    expect(trailingText).toBe(' now');
  });

  test('bare URL autolinks', () => {
    const nodes = renderMessageContent('check https://example.com/page for info');
    const [a] = elementsOfType(nodes, 'a');
    expect(a.props.href).toBe('https://example.com/page');
    expect(a.props.children).toBe('https://example.com/page');
  });

  test('a non-http(s) scheme renders as literal label text, not a clickable anchor', () => {
    const nodes = renderMessageContent('click [here](javascript:alert(1))');
    expect(elementsOfType(nodes, 'a')).toHaveLength(0);
    expect(nodes.join('')).toContain('here');
    expect(nodes.join('')).not.toContain('javascript:alert(1)');
  });
});

describe('malformed syntax', () => {
  test('unclosed ** falls back to literal text rather than consuming the rest of the message', () => {
    const content = 'this **is not closed and keeps going';
    const nodes = renderMessageContent(content);
    expect(elementsOfType(nodes, 'strong')).toHaveLength(0);
    expect(nodes.join('')).toBe(content);
  });

  test('unclosed [label]( with no matching close falls back to literal text', () => {
    const content = 'broken [link syntax here';
    const nodes = renderMessageContent(content);
    expect(elementsOfType(nodes, 'a')).toHaveLength(0);
    expect(nodes.join('')).toBe(content);
  });
});

describe('composes with mentions', () => {
  test('a mention still highlights inside bold text', () => {
    const nodes = renderMessageContent('**hey @bob check this out**');
    const [strong] = elementsOfType(nodes, 'strong');
    // The mention pass runs after bold, over what's left inside the bold
    // element's own children — this asserts the mention span survived
    // nested one level inside the <strong>, not that it was flattened away.
    const strongChildren = Array.isArray(strong.props.children) ? strong.props.children : [strong.props.children];
    const mentionSpan = strongChildren.find((c) => typeof c === 'object' && c?.type === 'span');
    expect(mentionSpan.props.children).toBe('@bob');
  });

  test('a plain mention outside any other token still highlights', () => {
    const nodes = renderMessageContent('hey @alice are you around?');
    const spans = elementsOfType(nodes, 'span');
    expect(spans).toHaveLength(1);
    expect(spans[0].props.children).toBe('@alice');
  });
});

describe('entities', () => {
  test('double-bracket entity renders as a span by default', () => {
    const nodes = renderMessageContent('deploy [[Server Alpha]] today');
    const spans = elementsOfType(nodes, 'span');
    expect(spans).toHaveLength(1);
    expect(spans[0].props.children).toBe('[[Server Alpha]]');
    expect(spans[0].props.style.color).toBe('var(--brg)');
  });

  test('entity can render as a clickable button when a callback is provided', () => {
    let clicked = null;
    const nodes = renderMessageContent('deploy [[Server Alpha]] today', {
      onEntityClick: (label) => {
        clicked = label;
      },
    });
    const [button] = elementsOfType(nodes, 'button');
    expect(button.props.children).toBe('[[Server Alpha]]');
    expect(button.props['aria-label']).toBe('Open entity Server Alpha');
    button.props.onClick();
    expect(clicked).toBe('Server Alpha');
  });

  test('entity and markdown link render independently', () => {
    const nodes = renderMessageContent('see [[Server Alpha]] and [docs](https://example.com)');
    expect(elementsOfType(nodes, 'span').map((s) => s.props.children)).toContain('[[Server Alpha]]');
    expect(elementsOfType(nodes, 'a')[0].props.href).toBe('https://example.com');
  });

  test('unclosed entity token remains literal text', () => {
    const content = 'deploy [[Server Alpha today';
    const nodes = renderMessageContent(content);
    expect(elementsOfType(nodes, 'span')).toHaveLength(0);
    expect(nodes.join('')).toBe(content);
  });

  test('entity longer than 255 chars remains literal text', () => {
    const label = 'x'.repeat(256);
    const content = `[[${label}]]`;
    const nodes = renderMessageContent(content);
    expect(elementsOfType(nodes, 'span')).toHaveLength(0);
    expect(nodes.join('')).toBe(content);
  });

  test('entity inside a mine bubble uses contrast style', () => {
    const nodes = renderMessageContent('deploy [[Server Alpha]]', { variant: 'mine' });
    const [span] = elementsOfType(nodes, 'span');
    expect(span.props.style.color).toBe('var(--item-active-fg)');
    expect(span.props.style.textDecoration).toBe('underline');
  });
});

describe('variant: "mine" (iMessage-style bubble layout entry)', () => {
  test('a mention inside a "mine" bubble uses the on-mine contrast style, not the default one', () => {
    const defaultNodes = renderMessageContent('hey @alice');
    const [defaultSpan] = elementsOfType(defaultNodes, 'span');
    const mineNodes = renderMessageContent('hey @alice', { variant: 'mine' });
    const [mineSpan] = elementsOfType(mineNodes, 'span');

    expect(defaultSpan.props.style.color).toBe('var(--brg)');
    expect(mineSpan.props.style.color).toBe('var(--item-active-fg)');
    // Color-only differentiation isn't available against a same-colored
    // bubble background — the on-mine variant needs a second visual cue.
    expect(mineSpan.props.style.textDecoration).toBe('underline');
  });

  test('a link inside a "mine" bubble uses the on-mine contrast style, not the default one', () => {
    const defaultNodes = renderMessageContent('see [docs](https://example.com)');
    const [defaultLink] = elementsOfType(defaultNodes, 'a');
    const mineNodes = renderMessageContent('see [docs](https://example.com)', { variant: 'mine' });
    const [mineLink] = elementsOfType(mineNodes, 'a');

    expect(defaultLink.props.style.color).toBe('var(--brg)');
    expect(mineLink.props.style.color).toBe('var(--item-active-fg)');
  });
});
