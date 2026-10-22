import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCoverage, parseGaps, queryTerms, withoutGapLines, type VaultStats } from '../../src/lib/ai/policy';
import { chunkVault, rankChunks, tokenize } from '../../src/lib/ai/rag';
import { buildSeedNotes } from '../../src/lib/vault/seed';

const chunks = chunkVault(buildSeedNotes());
const stats: VaultStats = { N: chunks.length, df: new Map() };
for (const c of chunks) for (const t of new Set(tokenize(`${c.title} ${c.section} ${c.text}`))) stats.df.set(t, (stats.df.get(t) ?? 0) + 1);
const gate = (q: string) => assessCoverage(q, rankChunks(chunks, q, { k: 5 }), stats).level;

test('the gate tells covered, partly covered and uncovered questions apart (before asking the model)', () => {
  assert.equal(gate('What does the squeeze theorem say?'), 'full');
  assert.equal(gate('When do I use the imperfect?'), 'full');
  assert.equal(gate('What are the regular -ar endings in the preterite?'), 'full');
  assert.equal(gate('What is the capital of Peru?'), 'none');
  assert.equal(gate("Explain L'Hôpital's rule"), 'none');
  assert.equal(gate('Who painted the Mona Lisa?'), 'none');
  assert.notEqual(gate('Explain the derivative of sin x'), 'full');
  assert.equal(gate('How do you conjugate tener in the preterite?'), 'partial');
});

test('what the question asks for is not what it is about', () => {
  assert.deepEqual(queryTerms('Can you explain what the squeeze theorem means?'), ['squeeze', 'theorem']);
  assert.deepEqual(queryTerms('¿Qué significa la niñez?'), ['ninez']);
});

test('gap lines are read and removed, however they are written', () => {
  const md = 'The notes cover endings [1].\n\nNOT IN NOTES: the preterite of tener\n**Not in your notes:** irregular stems.';
  assert.deepEqual(parseGaps(md), ['the preterite of tener', 'irregular stems']);
  assert.equal(withoutGapLines(md), 'The notes cover endings [1].');
});

test('a short follow-up is gated together with the question before it', async () => {
  const { gateQuery } = await import('../../src/lib/ai/policy');
  const q = gateQuery('And who discovered it?', 'What does the squeeze theorem say?');
  assert.notEqual(gate(q), 'none');
  assert.equal(gateQuery('What is the capital of Peru?', 'What does the squeeze theorem say?'), 'What is the capital of Peru?');
});

test('a distinctive word missing from the notes keeps a question from counting as fully covered', () => {
  assert.notEqual(gate("What is L'Hôpital's rule for limits?"), 'full');
  assert.notEqual(gate('What is the power rule for limits?'), 'full');
});

test('examples are found in code: the Spanish note has one, the organelles list does not', async () => {
  const { findExamples } = await import('../../src/lib/ai/policy');
  const pret = 'Use the preterite for completed actions with a clear beginning or end';
  assert.ok(findExamples(pret, rankChunks(chunks, pret, { k: 8 })).length);
  const org = 'Golgi apparatus — modifies, sorts and ships proteins';
  assert.equal(findExamples(org, rankChunks(chunks, org, { k: 8 })).length, 0);
});
