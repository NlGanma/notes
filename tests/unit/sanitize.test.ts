import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteFile } from '../../src/lib/vault/types';
import { docToHTML } from '../../src/lib/doc/toHTML';
import { safeColor, sanitizeStrokes } from '../../src/lib/vault/sanitize';

const evil = '0"/><img src=x onerror="alert(1)">';

test('a crafted .nib cannot inject markup through ink attributes', () => {
  const file = JSON.stringify({
    meta: { id: 'x', title: 'Shared' },
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            {
              type: 'inkInline',
              attrs: {
                w: evil,
                h: 10,
                em: 16,
                drop: 0,
                strokes: [{ id: 'a', brush: 'mono', color: `red" onload="x`, size: evil, pts: [0, 0, 0.5, 5, 5, 0.5] }],
              },
            },
          ],
        },
        {
          type: 'inkBlock',
          attrs: { height: '64px"><script>', ink: [{ id: '<b>', brush: 'nope', color: 'url(javascript:x)', size: 2, pts: ['1', 2, 0.5, 4, 'x', 0.5] }] },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'highlight', attrs: { color: 'red;background:url(http://evil)' } }] }] },
      ],
    },
  });
  const doc = parseNoteFile(file)!;
  const html = docToHTML(doc.content);
  assert.doesNotMatch(html, /onerror|onload|<script|javascript:|url\(/i);
  const inline = doc.content.content![0].content![1].attrs!;
  assert.equal(inline.w, 24);
  assert.equal(inline.strokes[0].color, '#1c1c1e');
  const ink = doc.content.content![1].attrs!;
  assert.equal(ink.height, 64);
  assert.equal(ink.ink[0].brush, 'ballpoint');
  assert.deepEqual(ink.ink[0].pts, [1, 2, 0.5, 4, 0, 0.5]);
});

test('ordinary colours and strokes pass through unchanged', () => {
  assert.equal(safeColor('#2160e8'), '#2160e8');
  assert.equal(safeColor('rgba(33, 96, 232, 0.4)'), 'rgba(33, 96, 232, 0.4)');
  assert.equal(safeColor('currentColor'), 'currentColor');
  assert.equal(safeColor('red; x: y'), '#1c1c1e');
  const s = { id: 's_1', brush: 'fountain' as const, color: '#1c1c1e', size: 2.4, pts: [1, 2, 0.5], pressure: true };
  assert.deepEqual(sanitizeStrokes([s]), [s]);
});
