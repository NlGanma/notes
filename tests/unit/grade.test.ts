import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, gradeShort, normalizeTex, quickRubric, scoreRubric } from '../../src/lib/review/grade';
import { alternatives } from '../../src/lib/review/items';

/** Grading checked against the slips a student really makes, and the ones that only look like slips. */

const R = '$R = \\frac{v_0^2 \\sin 2\\theta}{g}$';
const SQUEEZE = '$g(x) \\le f(x) \\le h(x)$';
const LIMIT = '$\\lim_{x \\to a} f(x) = L$';

test('dates and numbers have no “nearly”: a wrong year or month is wrong', () => {
  for (const [answer, key] of [
    ['June 1788', 'June 1789'],
    ['Mar 1789', 'May 1789'],
    ['14 July 1798', '14 July 1789'],
    ['15 July 1789', '14 July 1789'],
    ['1792–94', '1793–94'],
    ['1788', '1789'],
  ])
    assert.equal(gradeShort(answer, key).s, 0, `${answer} for ${key}`);
  assert.deepEqual(gradeShort('1793-94', '1793–94'), { s: 1 }, 'a hyphen for the dash is the same date');
  assert.deepEqual(gradeShort('June, 1789', 'June 1789'), { s: 1 });
});

test('formulas have no “nearly” either: a changed symbol, number or bracket is wrong', () => {
  for (const [answer, key] of [
    ['$R = \\frac{v_0^2 \\cos 2\\theta}{g}$', R],
    ['$R = \\frac{v_0^2 \\sin 2\\theta}{2g}$', R],
    ['$R = \\frac{v_0 \\sin 2\\theta}{g}$', R],
    ['R = \\frac{v_0^2 \\sin \\theta}{g}', R],
    ['$f(x) \\le g(x) \\le h(x)$', SQUEEZE],
    ['f(x) ≤ g(x) ≤ h(x)', SQUEEZE],
    ['\\lim_{x \\to 0} f(x) = L', LIMIT],
    ['$(a,b)$', '$[a,b]$'],
    ['(a,b)', '$[a,b]$'],
    ['$x^3$', '$x^2$'],
    ['$a_x = 1$', '$a_x = 0$'],
    ['$g = 9.9\\ \\text{m/s}^2$', '$g = 9.8\\ \\text{m/s}^2$'],
    ['$A \\leftarrow B$', '$A \\rightarrow B$'],
  ])
    assert.equal(gradeShort(answer, key).s, 0, `${answer} for ${key}`);
  assert.notEqual(normalizeTex('A \\rightarrow B'), normalizeTex('A \\leftarrow B'), '\\rightarrow is not \\right + arrow');
  assert.equal(normalizeTex('\\left( x \\right)'), normalizeTex('(x)'));
});

test('a formula written out as plain text is the same formula', () => {
  for (const [answer, key] of [
    ['R = v0^2 sin(2θ)/g', R],
    ['R = v0² sin(2 theta) / g', R],
    ['g(x) ≤ f(x) ≤ h(x)', SQUEEZE],
    ['g(x) <= f(x) <= h(x)', SQUEEZE],
    ['lim x→a f(x) = L', LIMIT],
    ['lim x->a f(x) = L', LIMIT],
    ['g = 9.8 m/s^2', '$g = 9.8\\ \\text{m/s}^2$'],
    ['a_x = 0', '$a_x = 0$'],
    ['[a, b]', '$[a,b]$'],
    ['x/2', '$\\frac{x}{2}$'],
  ])
    assert.equal(gradeShort(answer, key).s, 1, `${answer} for ${key}`);
  // Grouping is never guessed: e^x+1 is not e^{x+1}, and a/2g is not a/(2g).
  assert.equal(gradeShort('e^x+1', '$e^{x+1}$').s, 0);
  assert.equal(gradeShort('e^(x+1)', '$e^{x+1}$').s, 1);
  assert.equal(gradeShort('R = v0^2 sin(2θ)/2g', '$R = \\frac{v_0^2 \\sin 2\\theta}{2g}$').s, 0);
  assert.equal(gradeShort('R = v0^2 sin(2θ)/(2g)', '$R = \\frac{v_0^2 \\sin 2\\theta}{2g}$').s, 1);
});

test('a date written another way is the same date', () => {
  for (const [answer, key] of [
    ['August 1789', 'Aug 1789'],
    ['Aug. 1789', 'Aug 1789'],
    ['July 14, 1789', '14 July 1789'],
    ['14th July 1789', '14 July 1789'],
    ['14 Jul 1789', '14 July 1789'],
    ['1793–1794', '1793–94'],
    ['1793-1794', '1793–94'],
  ])
    assert.equal(gradeShort(answer, key).s, 1, `${answer} for ${key}`);
  assert.equal(gradeShort('July 1789', '14 July 1789').s, 0, 'less than the notes say is not the same date');
});

test('spelling tolerance is measured against each accepted answer, not the longest one', () => {
  const accept = ['daycare', 'nursery school'];
  assert.equal(gradeShort('day', 'daycare / nursery school', { accept }).s, 0);
  assert.equal(gradeShort('dayca', 'daycare / nursery school', { accept }).s, 0);
  assert.equal(gradeShort('daycar', 'daycare / nursery school', { accept }).s, 1);
  assert.equal(gradeShort('nursry school', 'daycare / nursery school', { accept }).s, 1);
  assert.equal(gradeShort('lysosome', 'Lysosomes').s, 1);
  assert.equal(gradeShort('Estates General', 'Estates-General').s, 1);
  assert.equal(gradeShort('mitocondria', 'Mitochondria').s, 1);
});

test('language classes: a one-letter slip is partly right; accents and articles stay right with a note', () => {
  assert.deepEqual(gradeShort('pelarse', 'pelearse', { language: true }), { s: 0.6, note: 'Watch the spelling: “pelearse”' });
  assert.deepEqual(gradeShort('el jugete', 'el juguete', { language: true }), { s: 0.6, note: 'Watch the spelling: “el juguete”' });
  // Against every accepted answer.
  assert.deepEqual(gradeShort('nursry school', 'daycare / nursery school', { accept: ['daycare', 'nursery school'], language: true }), {
    s: 0.6,
    note: 'Watch the spelling: “nursery school”',
  });
  assert.deepEqual(gradeShort('la ninez', 'la niñez', { language: true }), { s: 0.8, note: 'Check the accent: “la niñez”' });
  assert.deepEqual(gradeShort('niñez', 'la niñez', { language: true }), { s: 0.8, note: 'Include the article: “la niñez”' });
  // A date in a language class is still exact.
  assert.equal(gradeShort('1493', '1492', { language: true }).s, 0);
});

test('language classes: the English side may come with or without “a”, “the” or “to”', () => {
  assert.equal(gradeShort('a toy', 'toy', { language: true }).s, 1);
  assert.equal(gradeShort('the toy', 'toy', { language: true }).s, 1);
  assert.equal(gradeShort('fight', 'to fight', { language: true }).s, 1);
  assert.equal(gradeShort('to fight', 'fight', { language: true }).s, 1);
  // “a” is Spanish too: “veces” is not “a veces”.
  assert.equal(gradeShort('veces', 'a veces', { language: true }).s, 0);
});

test('a key with alternatives that share words: “portarse bien / mal” is “portarse bien” or “portarse mal”', () => {
  assert.deepEqual(alternatives('portarse bien / mal'), ['portarse bien', 'portarse mal']);
  assert.deepEqual(alternatives('to behave well / badly'), ['to behave well', 'to behave badly']);
  assert.deepEqual(alternatives('daycare / nursery school'), ['daycare', 'nursery school']);
  assert.deepEqual(alternatives('free in the cytosol or bound to the rough ER'), ['free in the cytosol', 'bound to the rough ER']);
  const es = { accept: alternatives('portarse bien / mal'), language: true };
  assert.equal(gradeShort('mal', 'portarse bien / mal', es).s, 0);
  assert.equal(gradeShort('portarse mal', 'portarse bien / mal', es).s, 1);
  const en = { accept: alternatives('to behave well / badly'), language: true };
  assert.equal(gradeShort('badly', 'to behave well / badly', en).s, 0);
  assert.equal(gradeShort('to behave badly', 'to behave well / badly', en).s, 1);
  assert.equal(gradeShort('behave badly', 'to behave well / badly', en).s, 1);
});

test('lists: every item once, nothing extra, for full marks; otherwise the share right, with the list', () => {
  const pret = '-é, -aste, -ó, -amos, -aron';
  const note = `Your notes list: ${pret}`;
  assert.deepEqual(gradeShort('-é, -aste, -ó, -amos', pret, { language: true }), { s: 0.8, note });
  assert.deepEqual(gradeShort('-é, -í, -aste, -iste, -ó, -ió, -amos, -imos, -aron, -ieron', pret, { language: true }), { s: 0.5, note });
  // A list that repeats an item (“-aba … -aba”) has four endings to know, not five.
  assert.deepEqual(gradeShort('-aba, -abas, -aban', '-aba, -abas, -aba, -ábamos, -aban', { language: true }), {
    s: 0.75,
    note: 'Your notes list: -aba, -abas, -aba, -ábamos, -aban',
  });
  assert.equal(gradeShort('-aba, -abas, -ábamos, -aban', '-aba, -abas, -aba, -ábamos, -aban', { language: true }).s, 1);
  assert.equal(gradeShort('é, aste, ó, amos, aron', pret, { language: true }).s, 1, 'typed without the hyphens');
  assert.equal(gradeShort('-aron, -amos, -é, -aste, -ó', pret, { language: true }).s, 1, 'in another order');
  assert.deepEqual(gradeShort('-e, -aste, -o, -amos, -aron', pret, { language: true }), { s: 0.8, note: `Check the accents: “${pret}”` });
});

const tax = 'Tax system — the First and Second Estates were largely exempt; the burden fell on the Third Estate.';
const bread = 'Bread prices — poor harvests in 1788 doubled the price of bread in Paris.';
const inter = 'Interrupted action: the imperfect sets the scene and the preterite interrupts it — Leía cuando sonó el teléfono.';

test('a free answer with the notes’ words in another role is not right by code (the grader decides)', () => {
  assert.equal(quickRubric('The Third Estate was largely exempt; the burden fell on the First and Second Estates.', [tax]), null);
  assert.equal(
    quickRubric(
      'Tax system: the Third Estate was largely exempt and the burden fell on the First and Second Estates. Bread prices: poor harvests in 1788 doubled the price of bread in Paris.',
      [tax, bread],
    ),
    null,
  );
  assert.equal(quickRubric('Interrupted action: the preterite sets the scene and the imperfect interrupts it, like Leía cuando sonó el teléfono.', [inter]), null);
  // A look-alike word is not the word: “imperative” is not “imperfect”.
  assert.equal(quickRubric('Interrupted action: the imperative sets the scene and the preterite interrupts it — Leía cuando sonó el teléfono.', [inter]), null);
  // The same words in the notes’ roles are right.
  assert.deepEqual(quickRubric('The First and Second Estates were largely exempt; the burden fell on the Third Estate.', [tax]), { s: 1 });
  assert.deepEqual(quickRubric('the imperfect sets the scene and the preterite interrupts it, like Leía cuando sonó el teléfono', [inter]), { s: 1 });
  assert.deepEqual(quickRubric([tax, bread].join('; '), [tax, bread]), { s: 1 });
});

test('a word matches a word of the notes, or its stem — not any word that starts the same', () => {
  assert.equal(coverage('imperfect', 'the imperative'), 0);
  assert.equal(coverage('photosynthesis', 'a photograph'), 0);
  assert.equal(coverage('nucleus', 'the nucleolus'), 0);
  assert.equal(coverage('completed actions', 'a complete action'), 1);
  assert.equal(coverage('El pretérito', 'the preterite'), 1);
  assert.equal(coverage('respiration', 'respire'), 1);
});

test('a formula in a key point is matched by the formula, not by the word “math”', () => {
  const laws = ['Sum: $\\lim (f+g) = \\lim f + \\lim g$', 'Product: $\\lim (fg) = (\\lim f)(\\lim g)$', 'Quotient: $\\lim \\frac{f}{g} = \\frac{\\lim f}{\\lim g}$ when $\\lim g \\neq 0$'];
  assert.equal(quickRubric('Sum, product and quotient math', laws), null);
  assert.equal(coverage(laws[0], 'sum math'), 0.5);
  assert.deepEqual(quickRubric(laws.join('. '), laws), { s: 1 });
  assert.equal(coverage(laws[0], 'Sum: lim(f+g) = lim f + lim g'), 1, 'written out as plain text');
  // A one-letter formula (“near $a$”) proves nothing either way.
  assert.equal(coverage('near $a$', 'near'), 1);
});

test('naming the idea an example shows is not nothing: the grader (or the student) decides', () => {
  const points = ['El pretérito', 'Use the preterite for completed actions with a clear beginning or end', 'Regular -ar endings: -é, -aste, -ó, -amos, -aron — hablé, hablaste, habló'];
  assert.equal(quickRubric('El pretérito', points), null);
  assert.equal(quickRubric('the preterite', points), null);
  assert.deepEqual(quickRubric('banana', points), { s: 0 });
  assert.deepEqual(quickRubric('idk', points), { s: 0 });
});

test('the grader’s evidence must be the student’s own words, and more than the question’s', () => {
  const pts = ['Mitochondria — site of cellular respiration; make ATP. Have their own DNA (endosymbiotic theory).'];
  const fact = '**Mitochondria** — site of cellular respiration; make **ATP**. Have their own DNA (endosymbiotic theory).';
  const asked = 'In your own words: what is **Mitochondria**, according to your notes?';
  const wrong = 'Mitochondria are where photosynthesis happens in plant cells.';
  // Quoting back the idea’s name (which the question shows) proves nothing.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'Mitochondria' }] }, pts, wrong, fact, asked).s, 0);
  // A quote that isn’t in the answer (copied from the notes) proves nothing.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'site of cellular respiration' }] }, pts, wrong, fact, asked).s, 0);
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'partly', quote: 'site of cellular respiration' }] }, pts, wrong, fact, asked).s, 0);
  // The student’s own words about the point count.
  const right = 'They are the site of cellular respiration and make ATP; they have their own DNA.';
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'site of cellular respiration' }] }, pts, right, fact, asked).s, 1);
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'Mitochondria make ATP' }] }, pts, 'Mitochondria make ATP for the cell.', fact, asked).s, 1);
  // An unquoted “yes” still counts half.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: '' }] }, pts, right, fact, asked).s, 0.5);
});

test('a lenient grader is capped whenever it gives credit, not only full marks', () => {
  const points = ['the imperfect sets the scene', 'the preterite interrupts it', 'Leía cuando sonó el teléfono'];
  const fact = 'Interrupted action: the imperfect sets the scene and the preterite interrupts it — Leía cuando sonó el teléfono.';
  const answer = 'imperfect preterite honestly grammar textbooks teachers classmates homework weekends holidays football music movies pizza beaches mountains rivers cities trains planes buses';
  const reply = { points: [{ n: 1, hit: 'yes' as const, quote: 'imperfect' }, { n: 2, hit: 'yes' as const, quote: 'preterite' }, { n: 3, hit: 'no' as const }] };
  assert.equal(scoreRubric(reply, points, answer, fact).s, 0.5);
});
