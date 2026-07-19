import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTasks, setTaskChecked } from '../src/services/taskParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../docs/task-tokenizer-fixtures.json'), 'utf8'),
);

// The shared fixture file (docs/task-tokenizer-fixtures.json) is the
// guardrail against this tokenizer and frontend/src/markdown.jsx's mirrored
// implementation quietly drifting apart (FEATURE_REQUEST.md entry 3) —
// frontend/src/markdown.test.jsx runs the exact same fixture list through
// its own line-detection pass.
describe('parseTasks — shared fixture parity', () => {
  for (const fixture of fixtures) {
    test(fixture.description, () => {
      expect(parseTasks(fixture.content)).toEqual(fixture.expectedTasks);
    });
  }
});

describe('parseTasks', () => {
  test('empty/undefined content yields no tasks', () => {
    expect(parseTasks('')).toEqual([]);
    expect(parseTasks(undefined)).toEqual([]);
  });

  test('a message with no checkbox syntax at all yields no tasks', () => {
    expect(parseTasks('just a normal message, nothing to see here')).toEqual([]);
  });

  test('the owner token key is a configurable alias, not hardcoded to "owner"', () => {
    const content = '- [ ] Ship it [assignee:: @jdoe]';
    // Default alias ("owner") does not recognize "assignee" as the token key
    // — the literal bracket text is left untouched, same as any other
    // unrecognized trailing text.
    expect(parseTasks(content)).toEqual([{ index: 0, checked: false, text: 'Ship it [assignee:: @jdoe]', owner: null }]);
    // Passing the alias explicitly (mirrors config.tasks.ownerTokenAlias /
    // TASK_OWNER_TOKEN_ALIAS) makes the same bracket key resolve to owner.
    expect(parseTasks(content, { ownerTokenAlias: 'assignee' })).toEqual([
      { index: 0, checked: false, text: 'Ship it', owner: 'jdoe' },
    ]);
  });

  test('buildTaskLineRegex escapes regex-meaningful characters in the alias', () => {
    // A pathological but well-formed alias (config.js's own startup
    // validation already restricts real deployments to
    // /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/, but the regex builder itself should
    // not silently misbehave on input outside that shape either). A literal
    // "." in the alias must not act as regex "any character": only the
    // exact alias resolves the owner group — a string differing by one
    // character in that position leaves the whole bracket as literal
    // description text instead of being captured as owner.
    expect(parseTasks('- [ ] task [owner.v2:: @bob]', { ownerTokenAlias: 'owner.v2' })).toEqual([
      { index: 0, checked: false, text: 'task', owner: 'bob' },
    ]);
    expect(parseTasks('- [ ] task [ownerXv2:: @bob]', { ownerTokenAlias: 'owner.v2' })).toEqual([
      { index: 0, checked: false, text: 'task [ownerXv2:: @bob]', owner: null },
    ]);
  });
});

describe('setTaskChecked', () => {
  test('flips only the target line\'s checkbox character, leaving everything else byte-for-byte identical', () => {
    const content = '- [ ] first\n- [ ] second [owner:: @al]\n- [x] third';
    const result = setTaskChecked(content, 1, true);
    expect(result).toBe('- [ ] first\n- [x] second [owner:: @al]\n- [x] third');
  });

  test('unchecking a checked task', () => {
    const content = '- [x] done already';
    expect(setTaskChecked(content, 0, false)).toBe('- [ ] done already');
  });

  test('returns null for an out-of-range index', () => {
    expect(setTaskChecked('- [ ] only one task here', 5, true)).toBeNull();
    expect(setTaskChecked('no tasks in this message at all', 0, true)).toBeNull();
  });

  test('rejects a negative index the same way (no task at that ordinal)', () => {
    expect(setTaskChecked('- [ ] one task', -1, true)).toBeNull();
  });

  test('non-task lines and interstitial content survive untouched', () => {
    const content = 'Notes before.\n- [ ] the only task\nNotes after.';
    expect(setTaskChecked(content, 0, true)).toBe('Notes before.\n- [x] the only task\nNotes after.');
  });

  test('toggling is idempotent — setting the same target state twice yields the same content', () => {
    const content = '- [ ] task';
    const once = setTaskChecked(content, 0, true);
    const twice = setTaskChecked(once, 0, true);
    expect(twice).toBe(once);
  });
});
