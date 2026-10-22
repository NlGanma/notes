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
