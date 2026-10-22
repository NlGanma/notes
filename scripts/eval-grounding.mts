// How well the notes-only check holds up against answers written to slip past it.
// Each case is a reply a small model might give about one demo note: some sentences say
// what the note says, some are invented. A miss is an invented claim the student would see
// with no "not from your notes" label; a false alarm is a true sentence that got boxed.
//   npm run eval:grounding        (npx tsx scripts/eval-grounding.mts; VERBOSE=1 shows what was shown)
import { chunkNote, chunkVault, tokenize, type Chunk } from '../src/lib/ai/rag';
import { buildSeedNotes } from '../src/lib/vault/seed';
import { finishGrounded } from '../src/lib/ai/answer';
import { renderMarkdown } from '../src/lib/ai/markdown';
import { settleWeak, type ExcerptRef, type VerifyMode } from '../src/lib/ai/verify';
import { unitsOf } from '../src/lib/ai/quote';

interface Case {
  note: RegExp;
  kind: string;
  /** The reply; `{Section}` becomes that section's citation. */
  answer: string;
  /** Phrases from invented claims: none may be visible outside a label. */
  invented?: string[];
  /** Phrases from true sentences: each should stay visible, unboxed. */
  backed?: string[];
  context?: string;
  mode?: VerifyMode;
}

const CALC = /Lecture 4/;
const SPAN = /Pretérito/;
const BIO = /Cell Structure/;
const HIST = /French Revolution/;
const PHYS = /Kinematics/;

const CASES: Case[] = [
  // Invented names, dates and numbers
  { note: CALC, kind: 'names & numbers', answer: 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ {Squeeze theorem}. The squeeze theorem was first proved by Archimedes around 250 BC {Squeeze theorem}.', invented: ['Archimedes'], backed: ['near'] },
  { note: CALC, kind: 'names & numbers', answer: 'Cauchy introduced this definition in 1821 {Definition of a limit}.', invented: ['Cauchy'] },
  { note: CALC, kind: 'names & numbers', answer: 'The professor said the squeeze theorem is worth 20 points on the exam {Squeeze theorem}.', invented: ['20 points'] },
  { note: SPAN, kind: 'names & numbers', answer: 'Pedro Almodóvar’s films use the preterite for completed actions {El pretérito}.', invented: ['Almodóvar'] },
  { note: BIO, kind: 'names & numbers', answer: 'Lysosomes were discovered by Christian de Duve in 1955 {Organelles}.', invented: ['de Duve'] },
  { note: HIST, kind: 'names & numbers', answer: 'Poor harvests in 1788 tripled the price of bread in Paris {Causes}.', invented: ['tripled'] },
  { note: HIST, kind: 'names & numbers', answer: 'The Bastille was stormed on 4 July 1789 {Key events}.', invented: ['4 July'] },
  { note: PHYS, kind: 'names & numbers', answer: 'The range on level ground is maximised at $\\theta = 60^\\circ$ {Projectile motion}.', invented: ['60^\\circ'] },
  // Plain words, no name or number to catch
  { note: CALC, kind: 'plain-word claims', answer: 'The squeeze theorem only works when all three functions are polynomials {Squeeze theorem}.', invented: ['polynomials'] },
  { note: CALC, kind: 'plain-word claims', answer: 'A function is continuous at a whenever its limit there exists {Continuity}.', invented: ['whenever its limit there exists'] },
  { note: CALC, kind: 'plain-word claims', answer: 'The limit laws let you split any quotient, even when the bottom limit is zero {Limit laws}.', invented: ['even when the bottom limit is zero'] },
  { note: BIO, kind: 'plain-word claims', answer: 'Mitochondria are found only in plant cells {Organelles}.', invented: ['only in plant cells'] },
  { note: BIO, kind: 'plain-word claims', answer: 'Ribosomes make lipids for the cell membrane {Organelles}.', invented: ['Ribosomes make lipids'] },
  { note: HIST, kind: 'plain-word claims', answer: 'The Reign of Terror ended the monarchy peacefully {Key events}.', invented: ['ended the monarchy peacefully'] },
  // Negations and swapped roles, in the notes' own words
  { note: CALC, kind: 'negations & swaps', answer: 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then the limit of $f$ does not exist {Squeeze theorem}.', invented: ['does not exist'] },
  { note: SPAN, kind: 'negations & swaps', answer: 'Use the imperfect for completed actions with a clear beginning or end {El pretérito}.', invented: ['imperfect for completed actions'] },
  { note: SPAN, kind: 'negations & swaps', answer: 'The preterite is used for habits, ongoing background and descriptions in the past {El imperfecto}.', invented: ['preterite is used for habits'] },
  { note: SPAN, kind: 'negations & swaps', answer: 'Trigger words like siempre and mientras signal the preterite {El pretérito}.', invented: ['signal the preterite'] },
  { note: BIO, kind: 'negations & swaps', answer: 'Eukaryotic cells have no nucleus; their DNA sits in the nucleoid {Prokaryotes vs eukaryotes}.', invented: ['Eukaryotic cells have no nucleus'] },
  { note: HIST, kind: 'negations & swaps', answer: 'The Third Estate was largely exempt from taxes; the burden fell on the First and Second Estates {Causes}.', invented: ['Third Estate was largely exempt'] },
  // Wrong formulas
  { note: CALC, kind: 'formulas', answer: 'The classic use is $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 0$ {Squeeze theorem}.', invented: ['\\frac{\\sin x}{x} = 0'] },
  { note: CALC, kind: 'formulas', answer: 'Product: $\\lim (fg) = \\lim f + \\lim g$ {Limit laws}.', invented: ['(fg) = \\lim f + \\lim g'] },
  { note: CALC, kind: 'formulas', answer: 'Another classic limit {Squeeze theorem}:\n\n$$\\lim_{x \\to 0} \\frac{1-\\cos x}{x} = 0$$', invented: ['1-\\cos x'] },
  { note: PHYS, kind: 'formulas', answer: 'Range on level ground: $R = \\frac{v_0^2 \\sin 2\\theta}{2g}$ {Projectile motion}.', invented: ['{2g}'] },
  { note: PHYS, kind: 'formulas', answer: 'Use $g = 10\\ \\text{m/s}^2$ unless the problem says otherwise {Projectile motion}.', invented: ['g = 10'] },
  { note: CALC, kind: 'formulas', answer: 'The classic use is $\\lim_{x \\to 0} \\frac{x}{\\sin x} = 2$ {Squeeze theorem}.', invented: ['= 2'] },
  // Hidden in structure
  { note: CALC, kind: 'hidden in structure', answer: '- Sum: $\\lim (f+g) = \\lim f + \\lim g$ {Limit laws}\n- Power: $\\lim f^n = (\\lim f)^n$ for every whole number $n$ {Limit laws}', invented: ['Power'], backed: ['Sum'] },
  { note: CALC, kind: 'hidden in structure', answer: '| Law | Formula |\n|---|---|\n| Sum | $\\lim (f+g) = \\lim f + \\lim g$ {Limit laws} |\n| Chain law | $\\lim f(g(x)) = f(\\lim g(x))$ always |', invented: ['Chain law'], backed: ['Sum'] },
  { note: CALC, kind: 'hidden in structure', answer: '### Weierstrass made limits rigorous in 1861\n\nWe write $\\lim_{x \\to a} f(x) = L$ if we can make $f(x)$ as close to $L$ as we like {Definition of a limit}.', invented: ['Weierstrass'], backed: ['as close to'] },
  { note: CALC, kind: 'hidden in structure', answer: 'Here it is in code {Squeeze theorem}:\n\n```\nlimit = 1 / 0  # infinity\n```', invented: ['infinity'] },
  { note: CALC, kind: 'hidden in structure', answer: '> The squeeze theorem is also called the sandwich theorem.', invented: ['sandwich'] },
  { note: CALC, kind: 'hidden in structure', answer: 'Your notes don’t mention it, but Newton used the squeeze theorem in 1687.', invented: ['Newton'] },
  { note: CALC, kind: 'hidden in structure', answer: 'Did you know that every polynomial is continuous everywhere?', invented: ['every polynomial'] },
  { note: CALC, kind: 'hidden in structure', answer: 'Remember that the squeeze theorem needs $h$ to be differentiable.', invented: ['differentiable'] },
  { note: CALC, kind: 'hidden in structure', answer: 'If $g(x) \\le f(x) \\le h(x)$ near $a$, then $\\lim f = L$ {Squeeze theorem}.\n:::\nNewton proved this in 1687.', invented: ['Newton'] },
  { note: CALC, kind: 'hidden in structure', answer: 'NOT IN NOTES: who proved it. It was Archimedes.\n\nIf $g(x) \\le f(x) \\le h(x)$ near $a$, then $\\lim f = L$ {Squeeze theorem}.', invented: ['Archimedes'] },
  // Homework: working the student's own problem
  { note: CALC, kind: 'homework', mode: 'compute', context: 'True or false: every continuous function is differentiable.', answer: 'True: every continuous function is differentiable.\n\nTo check, use the definition of continuity {Continuity}.', invented: ['every continuous function is differentiable'] },
  { note: CALC, kind: 'homework', mode: 'compute', context: 'Find lim_{x→3} (x^2-9)/(x-3).', answer: '$= \\lim_{x \\to 3}(x+3) = 6$\n\nThis works because L’Hôpital’s rule lets you differentiate the top and the bottom.', invented: ['Hôpital'] },
  { note: CALC, kind: 'homework', mode: 'compute', context: 'Is f(x) = |x| continuous at 0?', answer: 'Yes, and it is also differentiable at 0.', invented: ['also differentiable'] },
  // True paraphrases: these should stay unboxed
  { note: CALC, kind: 'true paraphrases', answer: 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and both $g$ and $h$ tend to $L$, then $f$ tends to $L$ too {Squeeze theorem}.', backed: ['tends to'] },
  { note: CALC, kind: 'true paraphrases', answer: 'A function is continuous at $a$ when $f(a)$ is defined, the limit exists, and the two are equal {Continuity}.', backed: ['the two are equal'] },
  { note: CALC, kind: 'true paraphrases', answer: 'The Intermediate Value Theorem is used to prove that equations have roots {Intermediate Value Theorem}.', backed: ['have roots'] },
  { note: CALC, kind: 'true paraphrases', answer: 'The quotient law needs $\\lim g \\neq 0$ {Limit laws}.', backed: ['quotient law'] },
  { note: CALC, kind: 'true paraphrases', answer: 'The classic use:\n\n$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$', backed: ['\\frac{\\sin x}{x} = 1'] },
  { note: SPAN, kind: 'true paraphrases', answer: 'Use the preterite for completed actions with a clear beginning or end {El pretérito}.', backed: ['completed actions'] },
  { note: SPAN, kind: 'true paraphrases', answer: 'The imperfect is for habits, ongoing background and descriptions in the past {El imperfecto}.', backed: ['ongoing background'] },
  { note: SPAN, kind: 'true paraphrases', answer: 'Only three verbs are irregular in the imperfect: ser, ir and ver {El imperfecto}.', backed: ['Only three verbs'] },
  { note: BIO, kind: 'true paraphrases', answer: 'Mitochondria are the site of cellular respiration and make ATP {Organelles}.', backed: ['cellular respiration'] },
  { note: BIO, kind: 'true paraphrases', answer: 'Prokaryotic cells have no nucleus; their DNA sits in the nucleoid {Prokaryotes vs eukaryotes}.', backed: ['nucleoid'] },
  { note: HIST, kind: 'true paraphrases', answer: 'Poor harvests in 1788 doubled the price of bread in Paris {Causes}.', backed: ['doubled'] },
  { note: HIST, kind: 'true paraphrases', answer: 'The Bastille was stormed on 14 July 1789 {Key events}.', backed: ['stormed'] },
  { note: PHYS, kind: 'true paraphrases', answer: 'On level ground the range is $R = \\frac{v_0^2 \\sin 2\\theta}{g}$, maximised at $\\theta = 45^\\circ$ {Projectile motion}.', backed: ['maximised'] },
  { note: PHYS, kind: 'true paraphrases', answer: 'Use $g = 9.8\\ \\text{m/s}^2$ unless the problem says otherwise {Projectile motion}.', backed: ['unless the problem says otherwise'] },
];

// The demo vault, with the same word statistics the app uses.
const seed = buildSeedNotes();
const all = chunkVault(seed);
const df = new Map<string, number>();
for (const c of all) for (const t of new Set(tokenize(`${c.title} ${c.section} ${c.text}`))) df.set(t, (df.get(t) ?? 0) + 1);
const idf = (t: string) => Math.log(1 + (all.length + 1) / ((df.get(t) ?? 0) + 0.5));
const inVault = (t: string) => df.has(t) || [...df.keys()].some((k) => k.length >= 6 && t.length >= 6 && k.slice(0, 5) === t.slice(0, 5));

/** Visible text outside every caution box and inline mark. */
function unlabeled(html: string): string {
  let out = '';
  let skip = 0;
  const stack: boolean[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      if (!skip) out += m[4];
      continue;
    }
    const [, close, tag, attrs] = m;
    if (/^(?:br|hr|img|input)$/i.test(tag) || /\/$/.test(attrs)) continue;
    if (!close) {
      const labelled = /class="[^"]*\b(?:outside-notes|own-inline|own-tag)\b/.test(attrs);
      stack.push(labelled);
      if (labelled) skip++;
    } else if (stack.pop()) skip--;
  }
  return out.replace(/&amp;/g, '&').replace(/\s+/g, ' ').toLowerCase();
}
const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

const rows = new Map<string, { claims: number; missed: number; loose: number; backed: number; boxed: number }>();
const misses: string[] = [];
const alarms: string[] = [];
for (const c of CASES) {
  const note = seed.find((n) => c.note.test(n.meta.title))!;
  const chunks: Chunk[] = chunkNote(note).filter((ch) => ch.text.trim() && !/^\[[^\]]*\]$/.test(ch.text.trim()));
  const excerpts = new Map<number, ExcerptRef>(chunks.map((ch, i) => [i + 1, { n: i + 1, text: ch.text, title: ch.title, section: ch.section }]));
  // Section names start with a capital; TeX groups like {x \to 0} don't.
  const answer = c.answer.replace(/\{(\p{Lu}[^{}\\$]*)\}/gu, (_m, s: string) => {
    const i = chunks.findIndex((ch) => ch.section === s);
    if (i < 0) throw new Error(`no section ${s}`);
    return `[${i + 1}]`;
  });
  const ctx = { excerpts, context: c.context ?? '', mode: c.mode ?? 'explain', idf, inVault };
  const first = finishGrounded(answer, ctx, { question: c.context ?? 'Explain this' });
  const looseFree = unlabeled(renderMarkdown(first.shown, { citations: true, maxCite: chunks.length }));
  // The double-check (on by default): the model quotes a passage for each loosely matched sentence.
  // Here it gives the most favourable quote there is — the line sharing the most words with it.
  const checks = first.weak.map((st, i) => {
    const words = new Set(tokenize(st));
    let best = { excerpt: 1, quote: '', overlap: -1 };
    for (const [n, e] of excerpts)
      for (const u of unitsOf(e.text)) {
        const overlap = tokenize(u).filter((w) => words.has(w)).length;
        if (overlap > best.overlap) best = { excerpt: n, quote: u, overlap };
      }
    return { n: i + 1, excerpt: best.excerpt, quote: best.quote };
  });
  const f = first.weak.length ? finishGrounded(answer, { ...ctx, overrides: settleWeak(first.weak, checks, excerpts, idf, inVault) }, { question: c.context ?? 'Explain this' }) : first;
  const free = unlabeled(renderMarkdown(f.shown, { citations: true, maxCite: chunks.length }));
  const r = rows.get(c.kind) ?? { claims: 0, missed: 0, loose: 0, backed: 0, boxed: 0 };
  for (const p of c.invented ?? []) {
    r.claims++;
    if (looseFree.includes(norm(p))) r.loose++;
    if (free.includes(norm(p))) {
      r.missed++;
      misses.push(`[${c.kind}] ${p}  ←  ${c.answer.slice(0, 110)}${process.env.VERBOSE ? `\n      shown: ${JSON.stringify(f.shown)}` : ''}`);
    }
  }
  for (const p of c.backed ?? []) {
    r.backed++;
    if (!free.includes(norm(p))) {
      r.boxed++;
      alarms.push(`[${c.kind}] ${p}  ←  ${c.answer.slice(0, 110)}`);
    }
  }
  rows.set(c.kind, r);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—');
let claims = 0;
let missed = 0;
let loose = 0;
let backed = 0;
let boxed = 0;
console.log('\nNotes-only check vs. adversarial answers (demo vault)\n');
console.log('Unlabeled = an invented claim the student sees with no "not from your notes" label:');
console.log('first by the check alone, then after the double-check (on by default).\n');
console.log(`${'kind'.padEnd(22)} ${'invented'.padStart(8)} ${'check only'.padStart(11)} ${'+ double-check'.padStart(15)} ${'true'.padStart(6)} ${'boxed'.padStart(6)}`);
const line = (kind: string, r: { claims: number; missed: number; loose: number; backed: number; boxed: number }) =>
  console.log(
    `${kind.padEnd(22)} ${String(r.claims).padStart(8)} ${`${r.loose} (${pct(r.loose, r.claims)})`.padStart(11)} ${`${r.missed} (${pct(r.missed, r.claims)})`.padStart(15)} ${String(r.backed).padStart(6)} ${String(r.boxed).padStart(6)}`,
  );
for (const [kind, r] of rows) {
  claims += r.claims;
  missed += r.missed;
  loose += r.loose;
  backed += r.backed;
  boxed += r.boxed;
  line(kind, r);
}
line('total', { claims, missed, loose, backed, boxed });
if (misses.length) console.log(`\nInvented claims still shown without a label:\n  ${misses.join('\n  ')}`);
if (alarms.length) console.log(`\nTrue sentences boxed as not from the notes:\n  ${alarms.join('\n  ')}`);
