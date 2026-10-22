import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandProof, findQuote, isSpanOf, normalizeForQuote } from '../../src/lib/ai/quote';

const PRET =
  '## El pretérito\nUse the **preterite** for completed actions with a clear beginning or end: Ayer comí paella. (Yesterday I ate paella.)\n- Regular **-ar** endings: **-é, -aste, -ó, -amos, -aron** — hablé, hablaste, habló\n- Trigger words: ayer, anoche, el año pasado, de repente, una vez';

test('quotes are compared without markdown, accents, quote styles or case', () => {
  assert.equal(normalizeForQuote('**Mitochondria** — “site” of  ATP'), 'mitochondria - "site" of atp');
  assert.ok(isSpanOf('regular -ar endings: -e, -aste, -o', PRET));
});

test('a short anchor expands to the note’s own line, never the model’s words', () => {
  assert.equal(expandProof('Regular -ar endings: -é, -aste', PRET), 'Regular **-ar** endings: **-é, -aste, -ó, -amos, -aron** — hablé, hablaste, habló');
  // Accent and markdown differences don't matter; the sentence is preferred over its whole line.
  assert.equal(expandProof('use the preterite for completed actions', PRET), 'Use the **preterite** for completed actions with a clear beginning or end: Ayer comí paella.');
  // A mostly-right anchor (one word off) still finds the line…
  assert.ok(expandProof('Trigger words ayer anoche el ano pasado de pronto', PRET)?.startsWith('Trigger words'));
  // …an invented one doesn't.
  assert.equal(expandProof('Nib invented this sentence it is not', PRET), null);
  assert.equal(expandProof('The preterite of ir is fui', PRET), null);
});

test('a whole quote is found only if the note says it', () => {
  assert.ok(findQuote('Ayer comí paella.', PRET));
  assert.equal(findQuote('Mañana comeré paella con mis amigos en la playa.', PRET), null);
});
