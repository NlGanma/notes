import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToEditorHTML, normalizeOutside, renderMarkdown } from '../../src/lib/ai/markdown';

test('inline and display math are typeset; prices are not math', () => {
  const html = renderMarkdown('Area is $\\pi r^2$.\n\n$$\\int_0^1 x\\,dx$$\n\nIt costs $5 and $10.');
  assert.match(html, /class="katex"/);
  assert.match(html, /md-display/);
  assert.match(html, /costs \$5 and \$10/);
});

test('citations become chips, including lists and ranges', () => {
  const html = renderMarkdown('Fact [1]. Others [2, 3] and [4–5].', { citations: true });
  for (const n of [1, 2, 3, 4, 5]) assert.match(html, new RegExp(`data-cite="${n}"`));
  assert.doesNotMatch(renderMarkdown('Fact [1].'), /data-cite/);
});

test('general-knowledge blocks render as a marked box', () => {
  const html = renderMarkdown("From notes [1].\n\n:::outside\nL'Hôpital's rule **says** this.\n:::\n\nBack [2].", { citations: true });
  assert.match(html, /class="outside-notes"/);
  assert.match(html, /Not from your notes/);
  assert.match(html, /<strong>says<\/strong>/);
  assert.match(html, /data-cite="2"/);
});

test('fence spellings are normalised and an unclosed block is closed (streaming)', () => {
  assert.equal(normalizeOutside('::: General knowledge\ntext'), ':::outside\ntext\n:::');
  assert.equal(normalizeOutside(':::not-from-notes\na\n:::\nb'), ':::outside\na\n:::\nb');
  assert.equal(normalizeOutside('no fences here'), 'no fences here');
  assert.match(renderMarkdown('Answer\n\n:::outside\nstill streaming'), /outside-notes[\s\S]*still streaming/);
});

test('inserted into a note, the general-knowledge part stays marked and citations are stripped', () => {
  const html = markdownToEditorHTML('Cited [1].\n\n:::outside\nNot in notes.\n:::', { stripCitations: true });
  assert.match(html, /data-variant="outside"/);
  assert.doesNotMatch(html, /\[1\]/);
  assert.match(markdownToEditorHTML('$x^2$'), /data-type="math-inline"/);
});

test('only real excerpt numbers become citations; intervals stay text', () => {
  const html = renderMarkdown('On [0, 1] the function is continuous [2]. See [9].', { citations: true, maxCite: 3 });
  assert.match(html, /data-cite="2"/);
  assert.doesNotMatch(html, /data-cite="0"|data-cite="9"/);
  assert.match(html, /On \[0, 1\]/);
});

test('inserting an answer strips citations but never touches math', () => {
  const html = markdownToEditorHTML('Continuous on $[0, 1]$ and $$\\int_{[1,2]} f$$ so a root exists [2].', { stripCitations: true });
  assert.match(html, /data-latex="\[0, 1\]"/);
  assert.match(html, /\\int_\{\[1,2\]\} f/);
  assert.doesNotMatch(html, /\[2\]/);
  assert.match(html, /root exists\./);
  // The student's own Markdown keeps its brackets.
  assert.match(markdownToEditorHTML('Interval [1, 2] here.'), /\[1, 2\]/);
});

test('intervals after "on", "in", "∈" stay text; bogus ranges never become chips', async () => {
  const { citedInAnswer } = await import('../../src/lib/ai/markdown');
  const a = renderMarkdown('Since f is continuous on [1, 2] and f(1)<0<f(2), there is a root [2].', { citations: true, maxCite: 5 });
  assert.match(a, /on \[1, 2\]/);
  assert.equal((a.match(/class="cite"/g) ?? []).length, 1);
  assert.doesNotMatch(renderMarkdown('x is in [1-20] or [5-2].', { citations: true, maxCite: 30 }), /data-cite/);
  // Inserting strips exactly what the chat showed as chips.
  const ins = markdownToEditorHTML('On [1, 10], f grows [1].', { stripCitations: true, maxCite: 3 });
  assert.match(ins, /On \[1, 10\], f grows\./);
  // The sources list counts only real citations, never math.
  assert.deepEqual([...citedInAnswer('Use $x \\in [2,3]$ and $[0, 1]$ as in the notes [1].', 3)], [1]);
});

test('a formula still being written is left out until it closes; prices, code and finished formulas stay', async () => {
  const { withoutOpenMath } = await import('../../src/lib/ai/markdown');
  assert.equal(withoutOpenMath('If $g \\le f$ near $a$ and $\\lim g = \\lim'), 'If $g \\le f$ near $a$ and');
  assert.equal(withoutOpenMath('Product: $\\lim (fg) = (\\lim [3]'), 'Product: [3]', 'a citation Nib added after it stays');
  assert.equal(withoutOpenMath('So\n\n$$\n\\lim_{x \\to 0}'), 'So');
  assert.equal(withoutOpenMath('It is \\(\\lim'), 'It is');
  assert.equal(withoutOpenMath(':::outside\nIn general $x^'), ':::outside\nIn general');
  assert.equal(withoutOpenMath(':::outside\nIn general $x^\n:::'), ':::outside\nIn general\n:::', 'the box the app closes stays closed');
  for (const done of ['It costs $5', 'From $5 to $10.', 'Area $\\pi r^2$.', 'Run `echo $HOME` first', 'Escaped \\$x', 'Done $a$.\n\nNext para $x$ ok', 'Total: 5$ each']) {
    assert.equal(withoutOpenMath(done), done);
  }
  // Only the last paragraph can still be open.
  assert.equal(withoutOpenMath('An odd $x line.\n\nThen [1].'), 'An odd $x line.\n\nThen [1].');
  // The end of a mark stays, so a marked item keeps its tag.
  const { OWN_OPEN, OWN_CLOSE, WEAK_OPEN, WEAK_CLOSE } = await import('../../src/lib/ai/markdown');
  assert.equal(withoutOpenMath(`- ${OWN_OPEN}The derivative is $nx^{n-1${OWN_CLOSE}`), `- ${OWN_OPEN}The derivative is${OWN_CLOSE}`);
  assert.equal(withoutOpenMath(`${WEAK_OPEN}Sum: $\\lim (f+g [1]${WEAK_CLOSE}`), `${WEAK_OPEN}Sum: [1]${WEAK_CLOSE}`);
});
