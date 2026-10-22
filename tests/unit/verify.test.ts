import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStatement, criticalTokens, historyForModel, splitSentences, verifyAnswer, type ExcerptRef, type VerifyCtx } from '../../src/lib/ai/verify';
import { chunkNote, chunkVault, tokenize } from '../../src/lib/ai/rag';
import { buildSeedNotes } from '../../src/lib/vault/seed';
import { OWN_CLOSE, OWN_OPEN } from '../../src/lib/ai/markdown';

// The demo vault: real notes, real IDF.
const seed = buildSeedNotes();
const all = chunkVault(seed);
const df = new Map<string, number>();
for (const c of all) for (const t of new Set(tokenize(`${c.title} ${c.section} ${c.text}`))) df.set(t, (df.get(t) ?? 0) + 1);
const idf = (t: string) => Math.log(1 + (all.length + 1) / ((df.get(t) ?? 0) + 0.5));
const inVault = (t: string) => df.has(t) || [...df.keys()].some((k) => k.length >= 6 && t.length >= 6 && k.slice(0, 5) === t.slice(0, 5));

const chunk = (title: RegExp, section: string) => {
  const n = seed.find((x) => title.test(x.meta.title))!;
  return chunkNote(n).find((c) => c.section === section)!;
};
const EX: ExcerptRef[] = [
  chunk(/Lecture 4/, 'Squeeze theorem'),
  chunk(/Lecture 4/, 'Continuity'),
  chunk(/Lecture 4/, 'Intermediate Value Theorem'),
  chunk(/Pretérito/, 'El pretérito'),
  chunk(/Pretérito/, 'El imperfecto'),
].map((c, i) => ({ n: i + 1, text: c.text, title: c.title, section: c.section }));
const ctx = (over: Partial<VerifyCtx> = {}): VerifyCtx => ({
  excerpts: new Map(EX.map((e) => [e.n, e])),
  context: 'Use the squeeze theorem to find the limit of x^2 sin(1/x) as x goes to 0.',
  mode: 'explain',
  idf,
  inVault,
  ...over,
});
const verdict = (s: string, cites: number[], over?: Partial<VerifyCtx>) => checkStatement(s, cites, ctx(over)).verdict;

test('statements that say what the cited notes say pass, paraphrases included', () => {
  const ok: [string, number[]][] = [
    ['The squeeze theorem says that if $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$.', [1]],
    ['If g is below f and f is below h near a, and both g and h tend to L, then f tends to L too.', [1]],
    ['Your notes say the limit of sin x over x as x goes to 0 is 1, and that it will be on the exam.', [1]],
    ['$f$ is continuous at $a$ when $f(a)$ is defined, the limit exists, and the two are equal.', [2]],
    ['Use the preterite for completed actions with a clear beginning or end, like Ayer comí paella.', [4]],
    ['The imperfect is used for habits and descriptions in the past, for example De niño, jugaba al fútbol.', [5]],
    ['Only three verbs are irregular in the imperfect: ser, ir and ver.', [5]],
  ];
  for (const [s, c] of ok) assert.notEqual(verdict(s, c), 'unsupported', s);
});

test('invented names, numbers, rules, negation flips and off-notes claims are caught', () => {
  const bad: [string, number[]][] = [
    ['The squeeze theorem was discovered by Archimedes in 250 BC near Syracuse.', [1]],
    ['It is also called the sandwich theorem or the pinching theorem.', [1]],
    ["You can also use L'Hôpital's rule to show that this limit is 1.", [1]],
    ['A function is continuous at $a$ when $f(a)$ is defined and the limit does not exist.', [2]],
    ['Every polynomial is continuous everywhere on the real line.', [2]],
    ['The preterite of ir and ser is fui, fuiste, fue.', [4]],
    ['The imperfect has many irregular verbs, such as tener and hacer.', [5]],
    ['Mitochondria are found in nearly every cell of the human body.', []],
    ['A removable discontinuity happens at x = 7 for this function.', [2]],
  ];
  for (const [s, c] of bad) assert.equal(verdict(s, c), 'unsupported', s);
});

test('a claim cited to the wrong excerpt is re-cited to the one that says it', () => {
  const c = checkStatement('The Intermediate Value Theorem is used to prove equations have roots [1].', [1], ctx());
  assert.equal(c.verdict, 'supported');
  assert.equal(c.repaired, 3);
  const uncited = checkStatement('If f is continuous on [a,b] and N is between f(a) and f(b), there is a c with f(c) = N.', [], ctx());
  assert.equal(uncited.repaired, 3);
});

test('talking to the student, naming a gap or restating their problem needs no source', () => {
  assert.equal(verdict('What two functions could $x^2 \\sin(1/x)$ sit between?', []), 'exempt');
  assert.equal(verdict("Your notes don't cover L'Hôpital's rule.", []), 'exempt');
  assert.equal(verdict('Try it and tell me what you get.', []), 'exempt');
  assert.equal(verdict('You need the limit of $x^2 \\sin(1/x)$ as $x$ goes to 0.', [], { mode: 'compute' }), 'exempt');
  // The student's own words are never evidence for a fact.
  const asked = { context: 'How do I use the squeeze theorem with the power rule?' };
  assert.equal(verdict('The power rule says the derivative of $x^n$ is $nx^{n-1}$.', [1], asked), 'unsupported');
  assert.equal(verdict('You use the squeeze theorem with the power rule by differentiating first.', [], asked), 'unsupported');
  // …but a hand-off can't smuggle in a fact.
  assert.equal(verdict('Remember that Newton proved this in 1687, so try it now.', []), 'unsupported');
});

test('working the student’s own problem allows derived numbers, not new methods', () => {
  const compute = { mode: 'compute' as const, context: 'Find lim_{x→3} (x^2-9)/(x-3).' };
  assert.equal(verdict('$= \\lim_{x \\to 3}(x+3) = 6$', [], compute), 'exempt');
  assert.equal(verdict('Apply the chain rule from calculus to differentiate it.', [], compute), 'unsupported');
  assert.deepEqual(criticalTokens('So $3 + 3 = 6$ by Euler', 'compute'), ['w:Euler']);
});

test('sentences split around math, decimals and abbreviations, citations stay put', () => {
  assert.deepEqual(splitSentences('First $a. B$ holds [1]. Then 3.5 m, e.g. More. Last one [2][3].'), [
    'First $a. B$ holds [1]. ',
    'Then 3.5 m, e.g. More. ',
    'Last one [2][3].',
  ]);
});

test('unsupported sentences move into a labelled box in place; supported ones stay', () => {
  const raw =
    'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1]. The squeeze theorem was first proved by Archimedes in 250 BC [1].\n\n$$\\pi \\approx 3.14$$\n\nIt is used to prove equations have roots [3].';
  const r = verifyAnswer(raw, ctx());
  assert.equal(r.contained, 1);
  assert.equal(r.supported, 2);
  assert.match(r.md, /^If \$g\(x\)[^\n]*\[1\]\.\n\n:::outside auto\nThe squeeze theorem was first proved by Archimedes in 250 BC\.\n\n\$\$\\pi \\approx 3\.14\$\$\n:::\n\nIt is used/);
  assert.ok(!/Archimedes[^\n]*\[1\]/.test(r.md), 'no citation inside the box');
});

test('in lists, unsupported items are marked inline so the list stays intact', () => {
  const raw = '1. $f(a)$ is defined [2]\n2. The function must also be differentiable at $a$ [2]\n3. the two are equal [2]';
  const r = verifyAnswer(raw, ctx());
  const lines = r.md.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith(`2. ${OWN_OPEN}`) && lines[1].endsWith(OWN_CLOSE), lines[1]);
  assert.ok(!lines[1].includes('[2]'));
  assert.equal(r.contained, 1);
});

test('the model’s own boxes are kept (without citations) and counted', () => {
  const r = verifyAnswer("Your notes don't cover L'Hôpital's rule.\n\n:::outside\nIt says lim f/g = lim f'/g' [2].\n:::", ctx());
  assert.equal(r.outside, 1);
  assert.equal(r.claims, 0);
  assert.match(r.md, /:::outside\nIt says lim f\/g = lim f'\/g'\.\n:::/);
});

test('history sent back to the model has no boxes and no old citation numbers', () => {
  const h = historyForModel('Squeeze it [1].\n\n:::outside auto\nArchimedes did it.\n:::\n\n- ok [2]');
  assert.ok(!/Archimedes|\[\d\]/.test(h), h);
});

test('the double-check promotes a sentence only with a real quote from the cited passage', async () => {
  const { settleWeak } = await import('../../src/lib/ai/verify');
  const ex = new Map(EX.map((e) => [e.n, e]));
  const st = ['The professor flagged this as one that will definitely be on the exam.', 'A function must also be differentiable at a.'];
  const settled = settleWeak(
    st,
    [
      { n: 1, excerpt: 1, quote: 'The professor said this one will definitely be on the exam' },
      { n: 2, excerpt: 2, quote: 'continuous and differentiable everywhere' },
    ],
    ex,
    idf,
  );
  assert.deepEqual(settled.get(st[0]), { verdict: 'supported', cite: 1 });
  assert.equal(settled.get(st[1])?.verdict, 'unsupported', 'a quote that is not in the passage promotes nothing');
  // A real quote that says something else promotes nothing either.
  const other = settleWeak(['Euler proved it in 1734.'], [{ n: 1, excerpt: 1, quote: 'The professor said this one will definitely be on the exam' }], ex, idf);
  assert.equal(other.get('Euler proved it in 1734.')?.verdict, 'unsupported');
});

test('a settled verdict replaces the checker’s own', () => {
  const s = 'The professor flagged this as one that will definitely be on the exam.';
  const r = verifyAnswer(`${s} [1]`, { ...ctx(), overrides: new Map([[s, { verdict: 'supported' as const }]]) });
  assert.equal(r.supported, 1);
  assert.equal(r.contained, 0);
});
