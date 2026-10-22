import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStatement, criticalTokens, historyForModel, markersToText, rearrangeCheck, settleWeak, splitSentences, verifyAnswer, type ExcerptRef, type VerifyCtx } from '../../src/lib/ai/verify';
import { verifyStudy } from '../../src/lib/ai/study';
import { unlabeled } from './fixtures';
import { chunkNote, chunkVault, tokenize } from '../../src/lib/ai/rag';
import { buildSeedNotes } from '../../src/lib/vault/seed';
import { markdownToEditorHTML, OWN_CLOSE, OWN_END, OWN_OPEN, renderMarkdown } from '../../src/lib/ai/markdown';
import { finishGrounded, leaveOutOwn, shownOf } from '../../src/lib/ai/answer';
import { parseGaps } from '../../src/lib/ai/policy';

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
  // The sentence and the formula (which the notes don't have either) are both counted, in one box.
  assert.equal(r.contained, 2);
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

/** What the student sees outside every label, after the check (as Message.tsx renders it). */
const visibleUnlabeled = (raw: string, over: Partial<VerifyCtx> = {}) =>
  unlabeled(renderMarkdown(finishGrounded(raw, ctx(over), { question: 'Explain the squeeze theorem' }).shown, { citations: true, maxCite: EX.length }));

test('a gap clause never exempts the rest of its sentence, nor a claim it makes', () => {
  assert.equal(verdict("Your notes don't mention it, but the squeeze theorem was first proved by Archimedes in 250 BC.", []), 'unsupported');
  assert.equal(verdict('The squeeze theorem was first proved by Archimedes in 250 BC, which your notes don’t cover.', []), 'unsupported');
  assert.equal(verdict('I couldn’t find it, but the derivative of sin x is cos x.', []), 'unsupported');
  assert.equal(verdict("Your notes don't say that Archimedes proved it in 250 BC.", []), 'unsupported');
  // Naming what's missing is not a claim.
  assert.equal(verdict("Your notes don't cover L'Hôpital's rule.", []), 'exempt');
  assert.equal(verdict('Your notes don’t explain why it works.', []), 'exempt');
});

test('short lines and questions need no source only when they add nothing the notes lack', () => {
  assert.equal(verdict('Polynomials are continuous everywhere.', []), 'unsupported');
  assert.equal(verdict('Did you know that polynomials are continuous everywhere?', []), 'unsupported');
  assert.equal(verdict('Remember to differentiate the inside function too.', []), 'unsupported');
  assert.equal(verdict('Try it and tell me what you get.', []), 'exempt');
  assert.equal(verdict('Is $f(a)$ defined?', []), 'exempt');
});

test('working a problem: a verdict on the student’s statement is a claim, never a restatement', () => {
  const hw = { mode: 'compute' as const, context: 'True or false: every continuous function is differentiable.' };
  assert.equal(verdict('True: every continuous function is differentiable.', [], hw), 'unsupported');
  assert.equal(verdict('Yes, every continuous function is differentiable.', [], hw), 'unsupported');
  assert.equal(verdict('Every continuous function is differentiable.', [], hw), 'unsupported');
  assert.ok(visibleUnlabeled('True: every continuous function is differentiable.\n\nTo show it, use the definition of continuity [2].', hw).indexOf('differentiable') < 0);
});

test('an equation the notes have, with a different right side, is a contradiction', () => {
  assert.equal(verdict('The classic use is $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 0$ [1].', [1]), 'unsupported');
  assert.equal(verdict('The classic use is $\\lim_{x\\to0}\\frac{\\sin x}{x}=1$ [1].', [1]), 'supported');
});

test('display math, code and long headings are checked; nothing outside a box is unchecked', () => {
  const ok = 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1].';
  // A formula from the notes stays; one the notes don't have is boxed, even after a supported sentence.
  assert.ok(!/outside/.test(finishGrounded(`${ok}\n\n$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$`, ctx()).shown));
  for (const extra of ['$$\\lim_{x \\to 0} \\frac{1-\\cos x}{x^2} = \\frac{1}{2}$$', '```\nprint("Archimedes, 250 BC")\n```', '~~~\nArchimedes 250 BC\n~~~', '### Archimedes proved the squeeze theorem in 250 BC']) {
    const free = visibleUnlabeled(`${ok}\n\n${extra}`);
    assert.ok(!/Archimedes|cos|frac/.test(free), `${extra} → ${free}`);
    assert.ok(/near/.test(free), 'the supported sentence stays');
  }
  // Short headings are labels.
  assert.match(finishGrounded(`## Steps\n\n${ok}`, ctx()).shown, /^## Steps/);
});

test('tables keep their cells; an unsupported row is marked cell by cell', () => {
  const raw = '| Idea | Detail |\n|---|---|\n| Squeeze theorem | $\\lim f = L$ when $g \\le f \\le h$ [1] |\n| Archimedes proved the squeeze theorem in 250 BC | history |';
  const shown = finishGrounded(raw, ctx()).shown;
  const html = renderMarkdown(shown, { citations: true, maxCite: EX.length }).replace(/\n/g, '');
  assert.match(html, /<th>Idea<\/th><th>Detail<\/th>/, 'the header is a header, not a marked claim');
  assert.equal((html.match(/<td>/g) ?? []).length, 4, 'every row keeps its two cells');
  assert.ok(!unlabeled(html).includes('Archimedes'));
});

test('in a list item each sentence is judged on its own', () => {
  const raw = '- Use the preterite for completed actions with a clear beginning or end [4]. Trigger words like siempre always take the preterite.\n- Regular -ar endings: -é, -aste, -ó [4]';
  const r = verifyAnswer(raw, ctx());
  assert.match(r.md.split('\n')[0], new RegExp(`^- Use the preterite[^${OWN_OPEN}]*\\[4\\]\\. ${OWN_OPEN}Trigger words`));
  assert.ok(!unlabeled(renderMarkdown(r.md, { citations: true, maxCite: EX.length })).includes('siempre'));
});

test('a fence the model writes cannot close a box early', () => {
  const shown = finishGrounded('Archimedes proved it in 250 BC.\n:::\nNewton used it in 1687 for orbits.', ctx()).shown;
  assert.ok(!/Archimedes|Newton/.test(unlabeled(renderMarkdown(shown))), shown);
});

test('copying keeps the labels; leaving out own knowledge leaves no trace of it', () => {
  const shown = 'From the notes [1].\n\n:::outside auto\nArchimedes proved it.\n:::\n\n- itemNewton did\n- loosely';
  const copied = markersToText(shown);
  assert.match(copied, /> \*\*Not found in your notes · treat this as the AI’s own knowledge — proceed with caution\*\*\n> Archimedes proved it\./);
  assert.match(copied, /Newton did _\(not from your notes\)_/);
  assert.match(copied, /loosely _\(loosely matched — check your notes\)_/);
  const left = leaveOutOwn(shown);
  assert.ok(!/Archimedes|Newton/.test(left), left);
  assert.match(left, /Left out — not in your notes/);
});

test('a reply that stopped before it was checked is shown boxed, never raw', () => {
  const raw = 'If g ≤ f ≤ h near a then lim f = L [1]. Archimedes proved it in 250 BC.';
  for (const status of ['stopped', 'error']) {
    const md = shownOf({ content: raw, grounding: 'library', status });
    assert.ok(!unlabeled(renderMarkdown(md)).includes('Archimedes'), status);
  }
  // App-written notices and rewrites of the student's own text are shown as they are.
  assert.equal(shownOf({ content: 'There isn’t enough in these notes yet.', grounding: 'library', status: 'done' }), 'There isn’t enough in these notes yet.');
  assert.equal(shownOf({ content: 'Reworded.', grounding: 'transform', status: 'stopped' }), 'Reworded.');
  // A general answer streaming into its box can't break out of it.
  assert.ok(!unlabeled(renderMarkdown(shownOf({ content: 'Fine.\n:::\nNewton, 1687.', ownOnly: true, status: 'streaming' }))).includes('Newton'));
});

test('the double-check never promotes a sentence with a word the student’s notes never use', () => {
  const ex = new Map(EX.map((e) => [e.n, e]));
  const st = 'The professor said the squeeze theorem, also called the sandwich theorem, will definitely be on the exam.';
  const quote = [{ n: 1, excerpt: 1, quote: 'The professor said this one will definitely be on the exam' }];
  assert.equal(settleWeak([st], quote, ex, idf, inVault).get(st)?.verdict, 'unsupported');
});

test('a "not in your notes" line names a topic; anything the model adds after it is dropped', () => {
  assert.deepEqual(parseGaps('NOT IN NOTES: who proved it. It was first proved by Archimedes in 250 BC.'), ['who proved it']);
});

test('bullets in place of the student’s paragraph may only rearrange it', () => {
  const para = 'In related rates problems we differentiate both sides with respect to time. Every changing quantity is a function of time, so the chain rule applies.';
  assert.deepEqual(rearrangeCheck(para, '- Differentiate both sides with respect to time.\n- Every changing quantity is a function of time, so the chain rule applies.'), []);
  assert.ok(rearrangeCheck(para, '- Differentiate both sides with respect to time.\n- Newton invented this in 1687.').length);
  assert.ok(rearrangeCheck(para, '- Differentiate both sides.\n- Always draw a careful labelled diagram first, then check units carefully.').length);
});

test('a flashcard is kept only when its question is about the passage that backs its answer', () => {
  const v = (front: string, back: string, source: number) =>
    JSON.parse(verifyStudy({ kind: 'flashcards', cards: [{ front, back, source }] }, ctx({ context: '' })).json).cards.length;
  assert.equal(v('When do you use the preterite?', 'Use the preterite for completed actions with a clear beginning or end.', 4), 1);
  // A true line of the notes, under a question it doesn't answer (the notes say the imperfect is for habits).
  assert.equal(v('Which tense do you use for habits and descriptions in the past?', 'Use the preterite for completed actions with a clear beginning or end.', 4), 0);
});

test('a line of the notes with two of its key terms swapped is a contradiction', () => {
  assert.equal(verdict('Use the imperfect for completed actions with a clear beginning or end [4].', [4]), 'unsupported');
  assert.equal(verdict('The preterite is used for habits, ongoing background and descriptions in the past [5].', [5]), 'unsupported');
  // Naming the other term alongside is not a swap.
  assert.notEqual(verdict('Unlike the imperfect, use the preterite for completed actions with a clear beginning or end [4].', [4]), 'unsupported');
});

test('a negation reaches only to the end of its clause; word forms match, look-alikes don’t', async () => {
  const { idfSupport, sameWord } = await import('../../src/lib/ai/verify');
  assert.equal(verdict('If $f$ is continuous on $[a,b]$, $N$ is between $f(a)$ and $f(b)$; there is no gap [3].', [3]), 'supported');
  assert.ok(sameWord('continuous', 'continuity') && sameWord('defin', 'definition'));
  assert.ok(!sameWord('differ', 'differentiable') && !sameWord('imperative', 'imperfect') && !sameWord('photograph', 'photosynthesis'));
  assert.deepEqual(idfSupport('differentiable', 'left and right limits differ').missing, ['differentiable']);
});

test('talking with the student is not a claim, and never makes a whole reply the AI’s own', () => {
  const tutor = { mode: 'compute' as const, context: 'Find lim_{x→3} (x^2-9)/(x-3).' };
  for (const line of ['Nice work!', 'Good — now plug in x = 3.', 'Your turn: try factoring the numerator.', 'You’re on the right track.', 'Take it one step at a time.', 'Double-check your algebra.'])
    assert.notEqual(verdict(line, [], tutor), 'unsupported', line);
  const f = finishGrounded('Nice work! You are close.\n\nWhat do you get when you plug in $x = 3$?', ctx(tutor), { question: tutor.context });
  assert.notEqual(f.banner, 'collapsed');
  assert.ok(!/outside/.test(f.shown), f.shown);
  // A hint that states a rule of the subject is still checked.
  assert.equal(verdict('Remember to differentiate the inside function too.', [], tutor), 'unsupported');
});

test('a formula of the notes applied to the student’s numbers is no contradiction; a fragment of one is not the notes', () => {
  assert.equal(verdict('So near $0$, if $\\lim g = \\lim h = 0$ then $\\lim f = 0$ [1].', [1]), 'supported');
  const frag = finishGrounded('If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1].\n\n$$\\frac{\\sin x}{x} = 1$$', ctx());
  assert.ok(!unlabeled(renderMarkdown(frag.shown)).includes('sin'), frag.shown);
  // The notes' formula re-spaced, with \leq or \left( … \right), is the notes' formula.
  const same = finishGrounded('In symbols [1]:\n\n$$g(x) \\leq f(x) \\leq h(x)$$', ctx());
  assert.ok(!/outside/.test(same.shown), same.shown);
});

test('claims hide in structure no longer: \\[ blocks, header rows, short headings, code fences, gap clauses', () => {
  const ok = 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1].';
  for (const extra of [
    '\\[\n\\lim_{x \\to 0}\\frac{1-\\cos x}{x^2}=\\frac12\n\\]',
    '| Every polynomial is continuous | Limits always exist |\n|---|---|\n| Sum | x |',
    '### Imperfect: completed actions',
    '```\n```python\nNewton proved the squeeze theorem in 1687.\n```\n```',
    'Your notes don’t mention Archimedes proving the squeeze theorem in 250 BC.',
    'Newton couldn’t find a proof of it, but the squeeze theorem holds.',
  ]) {
    const free = visibleUnlabeled(`${ok}\n\n${extra}`);
    assert.ok(!/cos|polynomial|always exist|imperfect: completed|Newton|Archimedes/i.test(free), `${extra} → ${free}`);
  }
});

test('“every”, “only” and opposite prefixes must be what a line of the notes says', () => {
  assert.equal(verdict('Every limit exists.', []), 'unsupported');
  assert.equal(verdict('Ser is regular.', []), 'unsupported');
  assert.equal(verdict('Only three verbs are irregular in the imperfect: ser, ir and ver [5].', [5]), 'supported');
});

test('copying keeps paragraphs apart, and citations are dropped without touching math', () => {
  const copied = markersToText('Before [1].\n\n:::outside auto\nArchimedes.\n:::\n\nAfter [1].');
  assert.match(copied, /> Archimedes\.\n\nAfter/);
  assert.match(shownOf({ content: 'On $[0, 1]$ it is continuous [1].', grounding: 'library', status: 'stopped' }), /\$\[0, 1\]\$/);
});

test('a table row not in the notes: every cell stays marked, the tag shows once per row', () => {
  const raw = [
    '| Law | What your notes say | Example |',
    '|---|---|---|',
    '| Squeeze theorem | $\\lim f = L$ when $g \\le f \\le h$ [1] | $x^2 \\sin(1/x)$ |',
    '| Archimedes | He proved the squeeze theorem in 250 BC | Syracuse |',
    '| Newton | He used it in 1687 for the orbits of planets | Principia |',
  ].join('\n');
  const shown = finishGrounded(raw, ctx()).shown;
  const rows = shown.split('\n').filter((l) => l.includes(OWN_OPEN));
  assert.equal(rows.length, 2, shown);
  for (const row of rows) {
    assert.equal(row.split(OWN_CLOSE).length - 1, 1, `one tag: ${row}`);
    assert.equal(row.split(OWN_OPEN).length - 1, 3, `every cell marked: ${row}`);
    assert.equal(row.split(OWN_END).length - 1, 2);
  }
  const html = renderMarkdown(shown, { citations: true, maxCite: EX.length });
  assert.equal((html.match(/class="own-tag"/g) ?? []).length, 2, 'one tag per row, not per cell');
  assert.equal((html.match(/class="own-inline"/g) ?? []).length, 6, 'each cell keeps its marking');
  assert.ok(!/Archimedes|Syracuse|Newton|Principia|1687/.test(unlabeled(html)), unlabeled(html));
  // Copied, sent back as history, or left out (strict mode): the rows keep their cells, and say it once.
  const copied = markersToText(shown);
  assert.equal((copied.match(/not from your notes/g) ?? []).length, 2, copied);
  for (const md of [historyForModel(shown), leaveOutOwn(shown)]) {
    const lines = md.split('\n').filter((l) => l.startsWith('|'));
    assert.ok(lines.every((l) => l.split('|').length === 5), md);
    assert.ok(!/Archimedes|Newton/.test(md), md);
    assert.equal((md.match(/left out/g) ?? []).length, 2, md);
  }
});

test('inserted into a note, a table becomes one bullet per row (the editor has no tables), still marked', () => {
  const ok = 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1].';
  const shown = finishGrounded(`${ok}\n\n| Law | Example |\n|---|---|\n| Archimedes proved the squeeze theorem | in 250 BC |`, ctx()).shown;
  const html = markdownToEditorHTML(shown, { stripCitations: true, maxCite: EX.length });
  assert.ok(!/<table|<td|<th/.test(html), html);
  assert.match(html, /<ul>\s*<li><p><strong>Law<\/strong> · <strong>Example<\/strong><\/p><\/li>/);
  assert.match(html, /<li><p>Archimedes proved the squeeze theorem · in 250 BC <em>\(not from your notes — the AI’s own knowledge\)<\/em><\/p><\/li>/);
  // Empty cells add no stray separators.
  assert.match(markdownToEditorHTML('| | A |\n|---|---|\n| x | |'), /<li><p><strong>A<\/strong><\/p><\/li>\s*<li><p>x<\/p><\/li>/);
});
