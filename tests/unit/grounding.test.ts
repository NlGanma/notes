import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsCitation, supportScore } from '../../src/lib/ai/grounding';

test('a sentence restating the excerpt is well supported; an unrelated one is not', () => {
  const excerpt = 'If g(x) ≤ f(x) ≤ h(x) near a and lim g = lim h = L, then lim f = L. The classic use: sin x over x tends to 1.';
  assert.ok(supportScore('By the squeeze theorem, since lim g = lim h = L, lim f = L near a.', excerpt) > 0.3);
  assert.ok(supportScore('Mitochondria produce ATP through the electron transport chain.', excerpt) < 0.18);
  // Very short statements are not judged.
  assert.equal(supportScore('Yes.', excerpt), 1);
});

test('statements need citations; talking to the student or naming a gap does not', () => {
  assert.equal(needsCitation('The derivative of sin x is cos x for every real number x.'), true);
  assert.equal(needsCitation('What do you get when you substitute x = 3?'), false);
  assert.equal(needsCitation("Your notes don't cover L'Hôpital's rule at all, unfortunately."), false);
  assert.equal(needsCitation('Ask your teacher whether you are expected to use it yet.'), false);
  assert.equal(needsCitation('Short one.'), false);
});

test('method steps that start with Now/Next still need a source', () => {
  assert.equal(needsCitation('Next, factor the numerator: (x-3)(x+3), so f simplifies to x+3.'), true);
  assert.equal(needsCitation('Now cancel the common factor and note the removable discontinuity.'), true);
  assert.equal(needsCitation('Now try the next step yourself and tell me what you get.'), false);
  assert.equal(needsCitation('Nowhere in the definition does the limit need f(a) to exist.'), true);
});
