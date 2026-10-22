import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docBlocks, docToText, estimateTokens, fitToBudget } from '../../src/lib/ai/context';
import { callout, h, m, p } from './fixtures';

test('notes become prompt text: math as LaTeX, handwriting via its transcript', () => {
  const text = docToText({
    type: 'doc',
    content: [
      h('Limits'),
      { type: 'paragraph', content: [{ type: 'text', text: 'We write ' }, m('\\lim_{x\\to a} f(x)')] },
      { type: 'inkBlock', attrs: { ink: [{ id: 's', pts: [0, 0, 0.5] }], transcript: { kind: 'math', text: 'x^2', latex: 'x^2', at: 1 } } },
      { type: 'inkBlock', attrs: { ink: [{ id: 't', pts: [0, 0, 0.5] }], transcript: null } },
      { type: 'mathBlock', attrs: { latex: 'e^{i\\pi}+1=0' } },
    ],
  });
  assert.match(text, /## Limits/);
  assert.match(text, /\$\\lim_\{x\\to a\} f\(x\)\$/);
  assert.match(text, /\[Handwritten: .*x\^2/);
  assert.match(text, /not transcribed yet/);
  assert.match(text, /\$\$e\^\{i\\pi\}\+1=0\$\$/);
});

test('bold and highlight markers hug the text, so a label typed with its space still reads as bold', () => {
  const bold = (text: string) => ({ type: 'text', text, marks: [{ type: 'bold' }] });
  const text = docToText({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [bold('ε–δ form: '), { type: 'text', text: 'for every ε' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'the ' }, { type: 'text', text: ' key words ', marks: [{ type: 'highlight' }] }, { type: 'text', text: 'here' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, bold(' '), { type: 'text', text: 'b' }] },
    ],
  });
  assert.equal(text, '**ε–δ form:** for every ε\n\nthe  ==key words== here\n\na b');
});

test('block list carries heading paths and can leave out assistant callouts', () => {
  const doc = { type: 'doc', content: [h('A'), p('one'), callout('outside', p('general')), h('B', 3), p('two')] };
  const all = docBlocks(doc);
  assert.equal(all.length, 5);
  const src = docBlocks(doc, { sourcesOnly: true });
  assert.equal(src.length, 4);
  assert.equal(src.at(-1)!.section, 'A › B');
});

test('fitToBudget keeps the part around the focus', () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const cut = fitToBudget(long, 100, 'line 350');
  assert.ok(estimateTokens(cut) <= 110);
  assert.match(cut, /line 350/);
  assert.equal(fitToBudget('short', 100), 'short');
});
