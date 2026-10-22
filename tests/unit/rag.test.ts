import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBm25, bm25Scores, chunkNote, chunkVault, formatExcerpts, rankChunks, tokenize, encodeVector, decodeVector, cosine } from '../../src/lib/ai/rag';
import { callout, note, p, vault } from './fixtures';

test('tokenize drops stop words, keeps math words and light-stems', () => {
  const t = tokenize('The limits of \\sin x and the derivatives');
  assert.ok(t.includes('limit'));
  assert.ok(t.includes('sin'));
  assert.ok(!t.includes('the'));
});

test('notes are chunked by section with heading paths and block ids', () => {
  const v = vault();
  const chunks = chunkNote(v.lecture4);
  assert.deepEqual(
    chunks.map((c) => c.section),
    ['Squeeze theorem', 'Continuity'],
  );
  assert.equal(chunks[0].folder, 'Calculus I');
});

test('assistant callouts pasted into a note are never retrieved as class material', () => {
  const v = vault();
  const text = chunkNote(v.lecture4)
    .map((c) => c.text)
    .join('\n');
  assert.ok(!/AI explanation/.test(text));
  // …however deep: one pasted into a list item or a quote too.
  const nested = note('Lecture 9', 'Calculus I', [
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('A limit is approached.'), callout('ai', p('Archimedes proved it in 250 BC.'))] }] },
    { type: 'blockquote', content: [callout('outside', p('Newton used it in 1687.'))] },
  ]);
  const nestedText = chunkNote(nested)
    .map((c) => c.text)
    .join('\n');
  assert.match(nestedText, /A limit is approached/);
  assert.ok(!/Archimedes|Newton/.test(nestedText), nestedText);
});

test('scopes: class folder, explicit notes, trash excluded', () => {
  const v = vault();
  const inClass = new Set(chunkVault(v.list, { kind: 'folder', path: 'Calculus I' }).map((c) => c.title));
  assert.ok(inClass.has('Lecture 5 — Derivatives'));
  assert.ok(!inClass.has('Old lecture'));
  assert.ok(!inClass.has('Cell Structure'));
  const picked = chunkVault(v.list, { kind: 'notes', ids: [v.cells.meta.id] });
  assert.deepEqual([...new Set(picked.map((c) => c.title))], ['Cell Structure']);
});

test('homework is never retrieved as class material unless picked explicitly', () => {
  const v = vault();
  assert.ok(!chunkVault(v.list).some((c) => c.title === 'Problem Set 4'));
  assert.ok(!chunkVault(v.list, { kind: 'folder', path: 'Calculus I' }).some((c) => c.title === 'Problem Set 4'));
  assert.ok(chunkVault(v.list, { kind: 'note', id: v.hw.meta.id }).length > 0);
});

test('BM25 ranks the passage that matches the question first', () => {
  const v = vault();
  const chunks = chunkVault(v.list);
  const scores = bm25Scores(buildBm25(chunks), 'what makes ATP in the cell');
  const best = chunks[scores.indexOf(Math.max(...scores))];
  assert.equal(best.title, 'Cell Structure');
  const hits = rankChunks(chunks, 'removable discontinuity', { k: 2 });
  assert.equal(hits[0].chunk.section, 'Continuity');
});

test('excerpts are numbered with where they came from', () => {
  const v = vault();
  const hits = rankChunks(chunkVault(v.list), 'squeeze theorem', { k: 1 });
  assert.match(formatExcerpts(hits), /^\[1\] \(Calculus I › "Lecture 4 — Limits & Continuity" › Squeeze theorem\)/);
});

test('vectors round-trip through base64 and cosine works', () => {
  const v = [0.25, -1, 3.5, 0];
  assert.deepEqual(Array.from(decodeVector(encodeVector(v))), v);
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100), 100);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100), 0);
});

test('tokenize folds accents and keeps words in any language', () => {
  assert.deepEqual(tokenize('El niño está en la guardería'), ['nino', 'esta', 'guarderia']);
  assert.deepEqual(tokenize('Más café, por favor'), ['mas', 'cafe', 'favor']);
  assert.ok(tokenize('λογος and \\theta').includes('λογος'));
  assert.ok(tokenize('λογος and \\theta').includes('theta'));
});

test('notes written by the AI are never retrieved as class material unless picked', async () => {
  const { note, p } = await import('./fixtures');
  const cards = note('Flashcards', 'Calculus I', [p('The squeeze theorem traps f between g and h.')], { generated: true });
  const v = vault();
  assert.ok(!chunkVault([...v.list, cards]).some((c) => c.title === 'Flashcards'));
  assert.ok(!chunkVault([...v.list, cards], { kind: 'folder', path: 'Calculus I' }).some((c) => c.title === 'Flashcards'));
  assert.ok(chunkVault([cards], { kind: 'note', id: cards.meta.id }).length > 0);
});
