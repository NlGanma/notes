import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docToMarkdown } from '../../src/lib/doc/toMarkdown';
import { docToHTML } from '../../src/lib/doc/toHTML';
import { parseNoteFile, serializeNote } from '../../src/lib/vault/types';
import { callout, h, m, note, p } from './fixtures';

const doc = {
  type: 'doc',
  content: [
    h('Limits'),
    { type: 'paragraph', content: [{ type: 'text', text: 'We write ' }, m('\\lim f'), { type: 'text', text: ' and bold', marks: [{ type: 'bold' }] }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p('one')] },
        { type: 'listItem', content: [p('two')] },
      ],
    },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }] },
    { type: 'mathBlock', attrs: { latex: 'x^2' } },
    callout('tip', p('remember')),
    {
      type: 'inkBlock',
      attrs: { height: 96, ink: [{ id: 's', brush: 'ballpoint', color: '#1c1c1e', size: 2.4, pts: [10, 10, 0.5, 60, 40, 0.5, 120, 20, 0.5] }] },
    },
  ],
};

test('Markdown export keeps structure, math and checklists', () => {
  const md = docToMarkdown('Lecture', doc);
  assert.match(md, /^# Lecture/);
  assert.match(md, /## Limits/);
  assert.match(md, /\$\\lim f\$/);
  assert.match(md, /\$ \*\*and bold\*\*/);
  assert.match(md, /- one\n- two/);
  assert.match(md, /- \[x\] done/);
  assert.match(md, /\$\$\nx\^2\n\$\$|\$\$x\^2\$\$/);
  assert.match(md, /> \[!TIP\]/);
});

test('HTML export typesets math and draws handwriting as SVG', () => {
  const html = docToHTML(doc);
  assert.match(html, /<h2[^>]*>Limits<\/h2>/);
  assert.match(html, /class="katex/);
  assert.match(html, /<svg[^>]*>[\s\S]*<path/);
  assert.match(html, /data-variant="tip"/);
});

test('notes round-trip through the .nib file format, homework included', () => {
  const n = note('PS 1', 'Calculus I/Homework', [p('Q1')], { homework: { sources: ['a'], folders: ['Calculus I'], due: 123, done: true }, tags: ['x'] });
  const back = parseNoteFile(serializeNote(n))!;
  assert.deepEqual(back.meta.homework, { sources: ['a'], folders: ['Calculus I'], due: 123, done: true });
  assert.equal(back.meta.folder, 'Calculus I/Homework');
  assert.deepEqual(back.content, n.content);
  assert.equal(parseNoteFile('{"not":"a note"}'), null);
  assert.equal(parseNoteFile('garbage'), null);
});
