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
