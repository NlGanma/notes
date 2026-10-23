import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptId, heuristicConcepts, notReviewable, type Concept } from '../../src/lib/review/concepts';
import { assertGroundedItem, blankOut, buildItem, hintFor, masteryNeeds, mulberry32, validateNudge, validateQuestion, type BuildCtx, type Item } from '../../src/lib/review/items';
import { gradeShort, isDontKnow, normalizeTex, quickRubric, scoreRubric } from '../../src/lib/review/grade';
import { chunkNote } from '../../src/lib/ai/rag';
import { DAY, freshState, isMastered, recordAnswer, type Level } from '../../src/lib/review/mastery';
import { buildSeedNotes } from '../../src/lib/vault/seed';
import { unreadLabels } from '../../src/lib/review/tree';
import { note, p } from './fixtures';

const seed = buildSeedNotes();
const byTitle = (t: string) => seed.find((n) => n.meta.title.startsWith(t))!;
const vocabNote = byTitle('Vocabulario');
const pretNote = byTitle('Pretérito');
const calcNote = byTitle('Lecture 4');
const cellNote = byTitle('Cell Structure');
const vocab = heuristicConcepts(vocabNote, { languageClass: true });
const pret = heuristicConcepts(pretNote, { languageClass: true });
const calc = heuristicConcepts(calcNote);
const cells = heuristicConcepts(cellNote);
const chunkOf = (noteId: string, c: Concept) =>
  chunkNote(seed.find((n) => n.meta.id === noteId)!).find((ch) => ch.hash === c.chunkHash)!.text;
const ctxFor = (c: Concept, siblings: Concept[], o: Partial<BuildCtx> = {}): BuildCtx => ({
  title: 'Notes',
  siblings,
  avoid: [],
  rng: mulberry32(1),
  chunkText: chunkOf(c.noteId, c),
  ...o,
});

test('ideas are read from the note’s own structure, with the note’s words as keys', () => {
  const ninez = vocab.find((c) => c.name === 'la niñez')!;
  assert.equal(ninez.kind, 'vocab');
  assert.deepEqual(
    ninez.facts.map((f) => f.key),
    ['la niñez', 'childhood'],
  );
  const preterite = pret.find((c) => c.name === 'El pretérito')!;
  assert.equal(preterite.kind, 'rule');
  assert.ok(preterite.facts.some((f) => f.example), 'an example sentence is kept as an example');
  assert.ok(preterite.facts.some((f) => f.key === '-é, -aste, -ó, -amos, -aron'));
  assert.ok(calc.find((c) => c.name === 'Squeeze theorem')?.exam, 'what the teacher flagged for the exam is marked');
  // Every fact is a span of the note itself.
  for (const c of [...vocab, ...pret, ...calc]) for (const f of c.facts) assert.ok(chunkOf(c.noteId, c).includes(f.text.slice(0, 20)) || f.fromInk, `${c.name}: ${f.text}`);
});

test('handwriting that is not transcribed yet is not reviewable (nothing to check answers against)', () => {
  assert.deepEqual(notReviewable(calcNote), ['Worked example (in class)']);
  assert.ok(!calc.some((c) => c.facts.some((f) => /not transcribed/.test(f.text))));
});

test('a vocabulary item asks for the note’s own word and accepts the note’s own alternatives', () => {
  const guarderia = vocab.find((c) => c.name === 'la guardería')!;
  const toSpanish = buildItem(guarderia, 0, ctxFor(guarderia, vocab, { firstExposure: false }));
  assert.equal(toSpanish.format, 'recall');
  assert.match(toSpanish.prompt, /daycare \/ nursery school/);
  assert.equal(toSpanish.expected, 'la guardería');
  // Asked again, the other direction.
  const toEnglish = buildItem(guarderia, 0, ctxFor(guarderia, vocab, { firstExposure: false, avoid: [toSpanish.key] }));
  assert.equal(toEnglish.expected, 'daycare / nursery school');
  assert.deepEqual(toEnglish.accept, ['daycare', 'nursery school']);
  for (const item of [toSpanish, toEnglish]) assert.ok(assertGroundedItem(item, chunkOf(guarderia.noteId, guarderia)));
  // Two different questions, so a word can be mastered (mastery needs two different items right).
  assert.notEqual(toSpanish.key, toEnglish.key);
  let st = freshState(0);
  for (const [i, it] of [toSpanish, toEnglish, toSpanish].entries())
    st = recordAnswer(st, { s: 1, graded: 'typed', level: it.level, key: it.key, conf: 'sure' }, guarderia.cap, i * DAY * 2);
  assert.ok(isMastered(st, guarderia.cap));
});

test('multiple choice on first exposure: every choice is a key from the notes', () => {
  const c = vocab.find((x) => x.name === 'el juguete')!;
  const siblings = vocab.filter((x) => x !== c);
  const sibTexts = siblings.flatMap((s) => s.facts.map((f) => f.text));
  for (const first of [true, false]) {
    const item = buildItem(c, 0, ctxFor(c, siblings, { firstExposure: first }));
    assert.ok(assertGroundedItem(item, chunkOf(c.noteId, c), sibTexts), `${item.format} is grounded`);
    if (item.choices) {
      assert.equal(item.choices.length, 4);
      assert.ok(item.choices.includes(item.expected!));
      assert.equal(item.choices[item.correct!], item.expected);
    }
  }
});

test('the grounding invariant rejects an item whose answer the notes don’t contain', () => {
  const c = vocab.find((x) => x.name === 'el juguete')!;
  const item = buildItem(c, 0, ctxFor(c, vocab, { firstExposure: false }));
  const text = chunkOf(c.noteId, c);
  assert.ok(assertGroundedItem(item, text));
  assert.ok(!assertGroundedItem({ ...item, expected: 'a wooden toy train' }, text), 'an invented answer key');
  assert.ok(!assertGroundedItem({ ...item, fact: 'Toys were invented in 1850.' }, text), 'an invented “your notes say”');
  assert.ok(!assertGroundedItem({ ...item, choices: ['toy', 'Napoleon'] }, text), 'an invented choice');
});

test('alternatives that share words (“portarse bien / mal”) are read from the key, and the item is still grounded', () => {
  const c = vocab.find((x) => x.name === 'portarse bien / mal')!;
  const toSpanish = buildItem(c, 0, ctxFor(c, vocab, { firstExposure: false }));
  const toEnglish = buildItem(c, 0, ctxFor(c, vocab, { firstExposure: false, avoid: [toSpanish.key] }));
  assert.deepEqual(toSpanish.accept, ['portarse bien', 'portarse mal']);
  assert.deepEqual(toEnglish.accept, ['to behave well', 'to behave badly']);
  const text = chunkOf(c.noteId, c);
  for (const item of [toSpanish, toEnglish]) assert.ok(assertGroundedItem(item, text), item.expected);
  assert.ok(!assertGroundedItem({ ...toSpanish, accept: ['portarse fatal'] }, text), 'an alternative the key doesn’t give');
});

test('a blank never hides most of a line, and leaves enough to know what is asked', () => {
  const f = { id: 'f', text: 'The **imperfect** describes ongoing or repeated past actions.', key: 'imperfect', example: false, fromInk: false, item: false };
  assert.equal(blankOut(f), 'The _____ describes ongoing or repeated past actions.');
  assert.equal(blankOut({ ...f, text: 'Imperfect tense here.', key: 'Imperfect tense here' }), null);
  assert.equal(blankOut({ ...f, text: 'The imperfect.', key: 'imperfect' }), null);
  assert.equal(blankOut({ ...f, key: 'not in the line' }), null);
});

test('higher levels come from the notes too: explain, apply with the note’s example, capped by what the notes hold', () => {
  const c = pret.find((x) => x.name === 'El pretérito')!;
  const explain = buildItem(c, 1, ctxFor(c, pret));
  assert.equal(explain.format, 'explain');
  assert.ok(explain.points!.length >= 1);
  const apply = buildItem(c, 2, ctxFor(c, pret));
  assert.equal(apply.format, 'apply');
  assert.match(apply.prompt, /Your notes give this example/);
  for (const it of [explain, apply]) assert.ok(assertGroundedItem(it, chunkOf(c.noteId, c), pret.flatMap((s) => s.facts.map((f) => f.text))), it.format);
  // Vocabulary is capped at recall: asking for level 3 still gives a level-0 item.
  const v = vocab[0];
  assert.equal(buildItem(v, 3, ctxFor(v, vocab)).level, 0);
});

test('an untitled note’s opening keeps the id it always had and is asked about as “this note”, never by a stand-in name', () => {
  const lines = [
    'Federalism splits sovereignty between a central government and regional governments, each with its own powers.',
    'A unitary state keeps sovereignty in the central government, which can create or abolish the regions.',
    '**Confederation** is a loose union of sovereign states that keep their own armies, currencies, courts and most of their powers.',
  ];
  const untitled = note('', 'Politics', lines.map((t) => p(t)));
  const cs = heuristicConcepts(untitled);
  const whole = cs.find((c) => c.whole)!;
  assert.ok(whole, 'the opening text is an idea');
  assert.equal(whole.id, conceptId(untitled.meta.id, 'This note'), 'progress stays under its old id');
  assert.ok(whole.partners.length, 'it sits beside the definition, so a “how do they connect” question is possible');
  const chunk = chunkNote(untitled)[0].text;
  for (const c of cs)
    for (let level = 0; level <= 3; level++) {
      const it = buildItem(c, level as Level, { title: '', siblings: cs, avoid: [], rng: mulberry32(1), chunkText: chunk });
      assert.doesNotMatch(it.prompt, /This note/, `${c.name} at ${level}: ${it.prompt}`);
      assert.ok(assertGroundedItem(it, chunk), `${c.name} at ${level}: ${it.format}`);
      if (c.whole) assert.doesNotMatch(it.prompt, /Federalism|unitary/, 'the question doesn’t read out the answer');
    }
  // The two questions connecting the opening and the definition are asked from each side.
  const connects = cs.map((c) => buildItem(c, 3, { title: '', siblings: cs, avoid: [], rng: mulberry32(1), chunkText: chunk })).filter((it) => it.format === 'connect');
  assert.equal(connects.length, 2);
  assert.notEqual(connects[0].prompt, connects[1].prompt);
  // A titled note's opening is still asked about by its title.
  const titled = heuristicConcepts(note('Lecture 12 — Federalism', 'Politics', [p(lines[0]), p(lines[1])]));
  assert.equal(titled[0].name, 'Lecture 12');
  assert.ok(!titled[0].whole);
});

test('unread handwriting is named the way the note is shown, with its section when it has one', () => {
  const ink = { type: 'inkBlock', attrs: { id: 'i1', ink: [{ points: [] }], transcript: null } };
  assert.deepEqual(unreadLabels(calcNote), ['Lecture 4 — Limits & Continuity › Worked example (in class)']);
  const untitled = note('', 'Politics', [p('Federalism splits sovereignty between levels of government.'), ink]);
  assert.deepEqual(notReviewable(untitled), ['Handwriting']);
  assert.deepEqual(unreadLabels(untitled), ['Federalism splits sovereignty between levels of government.']);
});

test('a model-phrased question is used only if the passage answers it, it gives nothing away and adds nothing', () => {
  const c = pret.find((x) => x.name === 'El pretérito')!;
  const text = chunkOf(c.noteId, c);
  const item = buildItem(c, 1, ctxFor(c, pret));
  const line = text.split('\n').find((l) => /-é, -aste/.test(l))!;
  const proof = line.replace(/^[-*]\s+/, '').split(/\s+/).slice(0, 8).join(' ');
  const good = validateQuestion({ question: 'In your own words, when do your notes say to use El pretérito?', proof, keyPoints: [] }, item, text, c.name);
  assert.ok(good, 'a fair question is accepted');
  assert.equal(good!.origin, 'model');
  assert.ok(text.replace(/\*\*/g, '').includes(good!.fact.replace(/\*\*/g, '').slice(0, 30)), 'the answer shown is the note’s own line');
  const bad = (question: string, p = proof) => validateQuestion({ question, proof: p, keyPoints: [] }, item, text, c.name);
  assert.equal(bad('What did Napoleon say about El pretérito in 1805?'), null, 'a false premise (a name and a year the notes don’t have)');
  assert.equal(bad('In your own words, what does El pretérito mean?', 'Plants turn sunlight into sugar using chlorophyll'), null, 'a proof that is not in the passage');
  assert.equal(bad('Why do the endings matter here?'), null, 'a question about something other than the idea');
  assert.equal(bad('ok?'), null, 'too short to be a question');
  // Applying the idea: the question quotes the note's example (the idea's name would be the answer).
  const apply = buildItem(c, 2, ctxFor(c, pret));
  const example = apply.source.text.replace(/\*\*/g, '');
  const ok = validateQuestion({ question: `Which idea from your notes does this example show, and why? “${example}”`, proof, keyPoints: [] }, apply, text, c.name);
  assert.ok(ok, 'an apply question that quotes the example is accepted');
  assert.equal(ok!.fact, apply.fact, '…and the answer shown is the idea, not the example');
  assert.notEqual(apply.fact, apply.source.text);
});

test('two key points the model quotes from the same line of the notes are one point', () => {
  const text = 'Mitochondria are the powerhouse of the cell and produce ATP through cellular respiration. Ribosomes build proteins from amino acids.';
  const line = text.split('. ')[0] + '.';
  const item = {
    key: 'c_x:f_y:explain',
    conceptId: 'c_x',
    factId: 'f_y',
    format: 'explain' as const,
    level: 1 as const,
    graded: 'rubric' as const,
    prompt: 'Explain **Mitochondria** in your own words.',
    fact: line,
    points: [line],
    source: { noteId: 'n1', title: 'Cells', section: 'Organelles', blockId: null, text },
    origin: 'template' as const,
  };
  const q = validateQuestion(
    { question: 'What do your notes say mitochondria do for the cell?', proof: 'Mitochondria are the powerhouse of the cell and produce ATP', keyPoints: ['the powerhouse of the cell', 'produce ATP through cellular respiration'] },
    item,
    text,
    'Mitochondria',
  );
  assert.ok(q);
  assert.equal(q!.points!.length, new Set(q!.points).size);
});

test('a model-phrased question may not name the idea its example shows, nor add a premise in plain words', () => {
  const c = pret.find((x) => x.name === 'El pretérito')!;
  const text = chunkOf(c.noteId, c);
  const apply = buildItem(c, 2, ctxFor(c, pret));
  const proof = 'Use the preterite for completed actions with a';
  const ask = (question: string, item = apply, cc = c, t = text, p = proof) => validateQuestion({ question, proof: p, keyPoints: [] }, item, t, cc.name);
  assert.equal(ask('Why is “Ayer comí paella” an example of the preterite for completed actions?'), null, 'the rule is the answer');
  assert.equal(ask('Why is “Ayer comí paella” an example of completed actions with a clear end?'), null, 'most of the rule, without its key word');
  assert.equal(ask('Which idea does “Ayer comí paella” show, according to El pretérito in your notes?'), null, 'the idea’s name is the answer');
  assert.ok(ask('Which idea from your notes does “Ayer comí paella” show, and why?'), 'quoting the example is fine');
  // Plain lowercase words can carry a false premise too.
  const mito = cells.find((x) => x.name === 'Mitochondria')!;
  const mt = chunkOf(mito.noteId, mito);
  const explain = buildItem(mito, 1, ctxFor(mito, cells));
  const mp = 'Mitochondria — site of cellular respiration; make';
  assert.equal(ask('Why do mitochondria stop producing ATP when oxygen runs out at night?', explain, mito, mt, mp), null);
  assert.ok(ask('In your own words, what do your notes say about Mitochondria?', explain, mito, mt, mp));
});

test('a hint from the model never gives the answer away, with or without accents and markdown', () => {
  const c = vocab.find((x) => x.name === 'la niñez')!;
  const item = buildItem(c, 0, ctxFor(c, vocab, { firstExposure: false }));
  assert.equal(item.expected, 'la niñez');
  const f = c.facts.find((x) => x.id === item.factId)!;
  const nudge = (n: string) => validateNudge(n, { item, blanked: blankOut(f) ?? f.text, answer: 'el niño', key: f.key });
  assert.ok(!nudge('Is it la ninez?'));
  assert.ok(!nudge('Is it **la niñez**?'));
  assert.ok(!nudge('Could the word be NIÑEZ?'));
  assert.ok(!nudge('Think of the Spanish word for a time of life — which is it?'), 'adds words the notes don’t have');
  assert.ok(!nudge('Look at your notes.'), 'not a question');
  assert.ok(nudge('What does the line in your notes say about childhood?'));
  // Applying an idea: the hint can't name it either.
  const p = pret.find((x) => x.name === 'El pretérito')!;
  const apply = buildItem(p, 2, ctxFor(p, pret));
  const ex = p.facts.find((x) => x.id === apply.factId)!;
  const hint = (n: string) => validateNudge(n, { item: apply, blanked: ex.text, answer: 'the imperfect', key: ex.key });
  assert.ok(!hint('Is it the preterite?'));
  assert.ok(hint('Which idea in your notes does Ayer comí paella show?'));
});

/**
 * What a hint must never say (checked apart from the app's own check, and more strictly): an item's
 * answer, alternatives, key, any part of a listed key, a formula of it or most of one, or a word of
 * the same stem as one of theirs — unless the question shows it. A formula cut in two is a leak too.
 */
function leakIn(hint: string, item: Item, key: string | null | undefined): string | null {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/\*\*|==|`/g, '');
  if ((hint.match(/(?<!\\)\$/g) ?? []).length % 2) return 'a formula cut in two';
  const h = fold(hint);
  const shown = fold(item.prompt);
  const words = (s: string): string[] => s.match(/\p{L}+/gu) ?? [];
  const fresh = words(h).filter((w) => !words(shown).includes(w));
  for (const a of [item.expected, ...(item.accept ?? []), key, ...(item.hide ?? [])]) {
    if (!a) continue;
    const parts = [a, ...(a.includes('$') ? (a.match(/\$\$[\s\S]*?\$\$|\$[^$]+\$/g) ?? []) : a.split(/[,/;]/))].map((p) => fold(p).trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
    for (const p of parts) {
      if (shown.includes(p)) continue;
      // As the e2e suite reads it: anywhere in the hint, even inside a word ("-é" with what follows it).
      if (p.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? h.includes(p) : new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(h)) return `“${p}”`;
      // Most of a formula, spaces aside.
      const tight = (s: string) => s.replace(/[\s$]/g, '');
      if (p.includes('$') && tight(p).length >= 6) {
        const f = tight(p);
        const n = Math.ceil(f.length * 0.6);
        for (let i = 0; i + n <= f.length; i++) if (tight(h).includes(f.slice(i, i + n))) return `most of ${p}`;
      }
    }
    // A word of the same stem ("imperfecto" for "imperfect", "pretérito" for "preterite").
    for (const w of words(fold(a.replace(/\$[^$]*\$/g, ' ')))) {
      if (w.length < 5 || words(shown).includes(w)) continue;
      const hit = fresh.find((x) => x.length >= 5 && (x.startsWith(w) || w.startsWith(x) || (x.length >= 6 && w.slice(0, 6) === x.slice(0, 6))));
      if (hit) return `“${hit}” for “${w}”`;
    }
  }
  return null;
}

test('a hint or a cue after a miss never gives the answer away, for every question the demo notes allow', () => {
  let checked = 0;
  for (const note of seed) {
    const cs = heuristicConcepts(note, { languageClass: /Spanish/.test(note.meta.folder) });
    for (const c of cs) {
      const keys = new Set<string>();
      for (const firstExposure of [true, false])
        for (let level = 0; level <= 3; level++) {
          const avoid: string[] = [];
          for (let i = 0; i < 6; i++) {
            const item = buildItem(c, level as 0, { title: note.meta.title, siblings: cs.filter((x) => x !== c), avoid, rng: mulberry32(i), firstExposure, chunkText: chunkOf(c.noteId, c) });
            avoid.push(item.key);
            if (keys.has(item.key)) continue;
            keys.add(item.key);
            const f = c.facts.find((x) => x.id === item.factId) ?? c.facts[0];
            for (const hint of [hintFor(item, f), hintFor(item, f, true)]) {
              const leak = leakIn(hint, item, f.key);
              assert.equal(leak, null, `${item.format} “${item.prompt.replace(/\s+/g, ' ').slice(0, 70)}” → “${hint}” gives away ${leak}`);
              assert.ok(!/Look at “([^”]+)” in \1\b/.test(hint), `the note is named once: ${hint}`);
              checked++;
            }
          }
        }
    }
  }
  assert.ok(checked > 150, `${checked} hints checked`);
});

test('a hint quotes the words next to the blank, never cutting a formula, and names a place only when it gives nothing away', () => {
  const ask = (cs: Concept[], name: string, want: (it: Item) => boolean) => {
    const c = cs.find((x) => x.name === name)!;
    for (let i = 0, avoid: string[] = []; i < 6; i++) {
      const it = buildItem(c, 0, ctxFor(c, cs.filter((x) => x !== c), { firstExposure: false, avoid, title: seed.find((n) => n.meta.id === c.noteId)!.meta.title }));
      if (want(it)) return { it, f: c.facts.find((x) => x.id === it.factId)! };
      avoid.push(it.key);
    }
    throw new Error(name);
  };
  // The words before the blank, from the start of the line.
  const pretCloze = ask(pret, 'El pretérito', (it) => it.expected === '-é, -aste, -ó, -amos, -aron');
  // (Where the line is from is on the card, not repeated in the question.)
  assert.equal(pretCloze.it.prompt, 'Fill in the blank:\n\n> Regular -ar endings: _____ — hablé, hablaste, habló');
  assert.equal(hintFor(pretCloze.it, pretCloze.f, true), 'Look at “El pretérito” in Pretérito vs. imperfecto: the line that starts “Regular -ar endings…”. What comes next?');
  // The term opens the line: the words after it — and not the term, nor a section named like the answer.
  const nucleus = ask(cells, 'Nucleus', () => true);
  assert.equal(hintFor(nucleus.it, nucleus.f), 'Look at “Organelles” in Cell Structure & Organelles: the line with “…holds DNA; the nucleolus…”.');
  const preterite = ask(pret, 'El pretérito', (it) => it.expected === 'preterite');
  assert.equal(hintFor(preterite.it, preterite.f), 'Look in your notes for the line that starts “Use the…”.');
  // A formula is quoted whole or not at all.
  const squeeze = ask(calc, 'Squeeze theorem', (it) => it.format === 'cloze' && /\$/.test(it.expected ?? ''));
  assert.equal(hintFor(squeeze.it, squeeze.f), 'Look at “Squeeze theorem” in Lecture 4 — Limits & Continuity: the line with “…near $a$ and $\\lim g = \\lim h = L$…”.');
  // A note with no sections is named once; a title holding the answer isn't named at all.
  const toEnglish = ask(vocab, 'portarse bien / mal', (it) => it.expected === 'to behave well / badly');
  assert.equal(hintFor(toEnglish.it, toEnglish.f), 'Look at “Vocabulario — la niñez”: the line that starts “portarse bien / mal…”.');
  const childhood = ask(vocab, 'la niñez', (it) => it.expected === 'la niñez');
  assert.equal(hintFor(childhood.it, childhood.f, true), 'Look in your notes for the line with “…childhood”. What comes before it?');
  // An explanation's words are its answer: only where to look.
  const explain = buildItem(pret[0], 1, ctxFor(pret[0], pret, { title: pretNote.meta.title }));
  assert.equal(explain.format, 'explain');
  assert.equal(hintFor(explain, pret[0].facts[0]), `Look at “${pret[0].section}” in Pretérito vs. imperfecto.`);
});

test('mastery needs follow what an idea’s notes allow; self-checked ideas take turns over their lines', () => {
  const lone = calc.find((x) => x.name === 'Removable discontinuity')!;
  assert.deepEqual(masteryNeeds(lone), { keys: 1, code: true }, 'a lone definition gives one question');
  assert.deepEqual(masteryNeeds(calc.find((x) => x.name === 'Limit laws')!), { keys: 2, code: false }, 'formulas are self-checked');
  assert.deepEqual(masteryNeeds(vocab.find((x) => x.name === 'la guardería')!), { keys: 2, code: true });
  // Nothing to blank: each line of the notes in turn, not the same prompt again and again.
  const facts = ['Every quantity that changes is treated as a function of time.', 'The units of the answer are the units of the quantity over time.'].map((text, i) => ({
    id: `f${i}`,
    text,
    key: null,
    example: false,
    fromInk: false,
    item: false,
  }));
  const c: Concept = { id: 'c', noteId: 'n', chunkHash: 'h', blockId: null, section: 'Related rates', name: 'Related rates', kind: 'fact', facts, partners: [], cap: 0, thin: false, origin: 'heuristic' };
  const ctx: BuildCtx = { title: 'Lecture 6', siblings: [], avoid: [], rng: mulberry32(1), chunkText: facts.map((f) => f.text).join('\n') };
  const first = buildItem(c, 0, ctx);
  const second = buildItem(c, 0, { ...ctx, avoid: [first.key] });
  assert.equal(first.format, 'rate');
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.prompt, second.prompt);
  assert.equal(masteryNeeds(c).keys, 2);
  // A reported item comes back only when nothing else is left.
  assert.equal(buildItem(c, 0, { ...ctx, avoid: [first.key, second.key], exclude: [first.key] }).key, second.key);
});

test('short answers: accents, articles and spelling get a note, not a zero', () => {
  assert.deepEqual(gradeShort('veia', 'veía', { language: true }), { s: 0.8, note: 'Check the accent: “veía”' });
  assert.deepEqual(gradeShort('juguete', 'el juguete', { language: true }), { s: 0.8, note: 'Include the article: “el juguete”' });
  assert.equal(gradeShort('mitocondria', 'Mitochondria').s, 1);
  assert.equal(gradeShort('-aron, -amos, -é, -aste, -ó', '-é, -aste, -ó, -amos, -aron', { language: true }).s, 1, 'a list in another order');
  assert.equal(gradeShort('-é, -aste', '-é, -aste, -ó, -amos, -aron', { language: true }).s, 0.4, 'part of a list');
  assert.equal(gradeShort('nursery school', 'daycare / nursery school', { accept: ['daycare', 'nursery school'] }).s, 1);
  assert.equal(gradeShort('banana', 'el juguete', { language: true }).s, 0);
  assert.equal(normalizeTex('\\dfrac{a}{ b }'), normalizeTex('\\frac a b'));
  assert.equal(gradeShort('$\\dfrac{x}{ 2 }$', '$\\frac{x}{2}$').s, 1);
});

test('“I don’t know” is an answer, not a guess to grade', () => {
  for (const a of ['', 'idk', 'I don’t know', "i don't know.", 'no sé', 'no lo sé', 'not sure', '?']) assert.ok(isDontKnow(a), a);
  assert.ok(!isDontKnow('the imperfect'));
});

test('free answers are scored against the note’s key points; the grader must quote the student', () => {
  const points = ['the imperfect sets the scene'];
  const fact = 'the imperfect sets the scene and the preterite interrupts it';
  assert.equal(quickRubric('If g is less than f and f less than h near a and lim g equals lim h equals L then lim f = L', ['If g(x) ≤ f(x) ≤ h(x) near a and lim g = lim h = L, then lim f = L.'])?.s, 1);
  // A "yes" backed by words that have nothing to do with the point proves nothing.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'bananas are yellow' }] }, points, 'bananas are yellow fruit', fact).s, 0);
  // A "yes" with no quote from the answer counts half.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: '' }] }, points, 'the imperfect is for scenes', fact).s, 0.5);
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'imperfect sets the scene' }] }, points, 'The imperfect sets the scene.', fact).s, 1);
  // Contradicting the notes costs.
  assert.equal(
    scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'imperfect sets the scene' }], contradicts: 'the preterite sets the scene too' }, points, 'The imperfect sets the scene, the preterite sets the scene too.', fact).s,
    0.75,
  );
});
