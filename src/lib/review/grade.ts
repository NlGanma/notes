import { tokenize } from '../ai/rag';
import { contentWords } from './concepts';

/**
 * Grading. Typed answers are graded by code against the note's own words,
 * forgiving the slips that don't show a gap in knowledge (and saying so) —
 * but not in a date, a number or a formula, where one character is the
 * answer. Free answers are graded against verbatim key points: by code when
 * the answer clearly contains them, in their order, otherwise by the model —
 * whose verdict must quote the student's own words, or it doesn't count.
 */

export interface Grade {
  s: number;
  /** A short note for the student ("Check the accent: “habló”"). */
  note?: string;
}

const IDK = /^\s*(?:idk|dunno|i\s*do\s*n[o'’]?t\s*know|no idea|not sure|pass|skip|no\s+(?:lo\s+)?s[eé]|ni idea|\?+|-+)[.!\s]*$/i;

export function isDontKnow(answer: string): boolean {
  return !answer.trim() || IDK.test(answer);
}

const strip = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[–—]/g, '-')
    .replace(/\*\*|==|`|_/g, '')
    .toLowerCase()
    .replace(/[“”"'‘’.,;:!?¿¡()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '');

/** Relations typed as symbols or in ASCII, as LaTeX: "≤" and "<=" are "\le". */
const relations = (s: string) =>
  s
    .replace(/≤|<=/g, '\\le ')
    .replace(/≥|>=/g, '\\ge ')
    .replace(/→|->/g, '\\to ')
    .replace(/←/g, '\\gets ')
    .replace(/\\leq(?![a-zA-Z])/g, '\\le')
    .replace(/\\geq(?![a-zA-Z])/g, '\\ge')
    .replace(/\\rightarrow(?![a-zA-Z])/g, '\\to')
    .replace(/\\leftarrow(?![a-zA-Z])/g, '\\gets');

export function normalizeTex(s: string): string {
  return s
    .trim()
    .replace(/^\$+|\$+$/g, '')
    .replace(/\\left(?![a-zA-Z])|\\right(?![a-zA-Z])|\\[,!;:]|\\d?frac/g, (m) => (/frac/.test(m) ? '\\frac' : ''))
    .replace(/\\cdot/g, '*')
    .replace(/\s+/g, '')
    .replace(/\{(\w)\}/g, '$1');
}

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  varphi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
};
const GREEK_WORD = new RegExp(`(?<![a-zA-Z])(?:${Object.keys(GREEK).join('|')})(?![a-zA-Z])`, 'g');

/**
 * A formula as plain text, so one typed without LaTeX can be compared:
 * "R = v0^2 sin(2θ)/g" and "$R = \frac{v_0^2 \sin 2\theta}{g}$" are both
 * "R=v0^2sin2θ/g". Brackets are dropped only where that can't change the
 * meaning — around one letter or number, a function's argument, a product
 * over something — so "e^x+1" is never "e^{x+1}".
 */
function plainMath(s: string): string {
  let t = relations(s.replace(/²/g, '^2').replace(/³/g, '^3').normalize('NFKC'))
    .trim()
    .replace(/^\$+|\$+$/g, '')
    .replace(/\\(?:left|right)(?![a-zA-Z])|\\[,!;: ]/g, '')
    .replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, '$1')
    .replace(/\\[dt]frac(?![a-zA-Z])/g, '\\frac');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
  }
  t = t
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    // The range under a limit or a sum is written out: "\lim_{x \to a}" is "lim x→a".
    .replace(/\\?(lim|sum|prod|max|min|sup|inf)_[{(]([^{}()]*)[})]/g, '$1 $2 ')
    .replace(/\\le(?![a-zA-Z])/g, '<=')
    .replace(/\\ge(?![a-zA-Z])/g, '>=')
    .replace(/\\to(?![a-zA-Z])/g, '->')
    .replace(/\\gets(?![a-zA-Z])/g, '<-')
    .replace(/\\neq?(?![a-zA-Z])|≠/g, '!=')
    .replace(/\\(?:cdot|times)(?![a-zA-Z])|[·×]/g, '*')
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) => GREEK[name] ?? name)
    .replace(GREEK_WORD, (g) => GREEK[g])
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\s+/g, '')
    .replace(/\*\*/g, '^')
    .replace(/\*/g, '');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t
      // A function's argument: "sin(2θ)" is "sin 2θ" (but not "sin(x)^2").
      .replace(/(sin|cos|tan|sec|csc|cot|log|ln|exp)\(([^()+\-=<>,!]+)\)(?!\^)/g, '$1$2')
      // One letter or number: "(g)" is "g" — but "f(x)" stays.
      .replace(/(?<![\p{L}\p{N}])\((\p{L}|\d+(?:\.\d+)?)\)/gu, '$1')
      // A product over something: "(v0^2 sin 2θ)/g" is "v0^2 sin 2θ/g".
      .replace(/(?<![\p{L}\p{N}^_)/])\(([^()+\-=<>,!]+)\)\//gu, '$1/');
  }
  return t.replace(/_/g, '');
}

/** The same formula, as LaTeX (spacing and \dfrac aside) or written out as plain text. */
const sameMath = (a: string, b: string) => normalizeTex(relations(a)) === normalizeTex(relations(b)) || plainMath(a) === plainMath(b);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A date in one form: "Aug 1789" and "August 1789", "14 July 1789" and "July 14, 1789", "1793–94" and "1793–1794". */
function dateForm(s: string): string | null {
  const t = strip(s).replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, '$1');
  const range = /^(\d{3,4}) ?(?:-|to) ?(\d{1,4})$/.exec(t);
  if (range) {
    const [, from, to] = range;
    // "1793–94" ends in 1794; "1799–01" in 1801.
    let end = Number(to.length < from.length ? from.slice(0, from.length - to.length) + to : to);
    if (end < Number(from)) end += 10 ** to.length;
    return `${from}-${end}`;
  }
  const d = /^(?:(\d{1,2}) )?([a-z]{3,}) (?:(\d{1,2}) )?(\d{3,4})$/.exec(t);
  if (!d || (d[1] && d[3])) return null;
  const month = MONTHS.findIndex((m) => m.startsWith(d[2]));
  return month < 0 ? null : `${d[1] ?? d[3] ?? '-'} ${month + 1} ${d[4]}`;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const ARTICLES = /^(?:el|la|los|las|un|una|unos|unas|le|les|der|die|das)\s+/;
/** The English side of a gloss without "a", "the" or "to" — "a" only on the student's side, as it's Spanish too ("a veces"). */
const english = (s: string, key = false) => s.replace(key ? /^(?:an|the|to)\s+/ : /^(?:an?|the|to)\s+/, '');
const TEX = /[\\$^_{}]/;

/**
 * A typed answer against the note's answer. In language classes accents and
 * articles are part of the answer (right, with a note) and a slip of one
 * letter can make another word (partly right); elsewhere a spelling slip is
 * forgiven. Never in a date, a number or a formula.
 */
export function gradeShort(answer: string, key: string, opts: { accept?: string[]; language?: boolean } = {}): Grade {
  if (isDontKnow(answer)) return { s: 0 };
  const cands = [key, ...(opts.accept ?? [])].filter((x) => strip(x));
  // Math: the formula itself, written in LaTeX or as plain text.
  if (TEX.test(key)) return cands.some((x) => sameMath(x, answer)) ? { s: 1 } : { s: 0 };
  const a = strip(answer);
  const keys = cands.map(strip);
  const k = strip(key);
  if (keys.includes(a)) return { s: 1 };
  const date = dateForm(answer);
  if (date && cands.some((x) => dateForm(x) === date)) return { s: 1 };
  // A list ("-é, -aste, -ó, -amos, -aron"): every item once, in any order; part of it, or more, is partly right.
  const kp = listItems(key);
  if (kp.length >= 3) {
    const ap = listItems(answer);
    const n = Math.max(kp.length, ap.length);
    const hit = kp.filter((p) => ap.some((x) => x === p || (!opts.language && fold(x) === fold(p)))).length;
    const accentHit = kp.filter((p) => ap.some((x) => fold(x) === fold(p))).length;
    if (hit === n) return { s: 1 };
    if (opts.language && accentHit === n) return { s: 0.8, note: `Check the accents: “${clean(key)}”` };
    if (hit > 0) return { s: Math.round((hit / n) * 100) / 100, note: `Your notes list: ${clean(key)}` };
  }
  // One character is the answer in a date or a number: no "nearly" there.
  const loose = (x: string) => !/\d/.test(x);
  const language = opts.language || /[áéíóúñü¿¡]/i.test(key);
  if (language) {
    if (keys.some((x) => english(x, true) === english(a))) return { s: 1 };
    if (keys.some((x) => fold(x) === fold(a))) return { s: 0.8, note: `Check the accent: “${clean(key)}”` };
    if (ARTICLES.test(k) && keys.some((x) => x.replace(ARTICLES, '') === a)) return { s: 0.8, note: `Include the article: “${clean(key)}”` };
    // "pelarse" is another word than "pelearse": partly right.
    const i = keys.findIndex((x) => loose(x) && x.length >= 5 && levenshtein(fold(a), fold(x)) === 1);
    if (i >= 0) return { s: 0.6, note: `Watch the spelling: “${clean(cands[i])}”` };
  } else {
    const i = keys.findIndex((x) => fold(x) === fold(a) || (loose(x) && x.length >= 4 && levenshtein(fold(a), fold(x)) <= Math.max(1, Math.floor(x.length / 6))));
    if (i >= 0) return { s: 1, note: `(spelling: “${clean(key)}”)` };
  }
  return { s: 0 };
}

const stripKeepDashes = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[–—]/g, '-')
    .replace(/\*\*|==|`/g, '')
    .toLowerCase()
    .replace(/[“”"'‘’.;:!?¿¡()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** A list's items, each once, with or without its hyphen ("-é" or "é"). */
const listItems = (x: string) => [
  ...new Set(
    stripKeepDashes(x)
      .split(/\s*[,;/]\s*|\s+and\s+|\s+y\s+/)
      .map((p) => p.trim().replace(/^-\s*/, ''))
      .filter(Boolean),
  ),
];
const clean = (s: string) => s.replace(/\*\*|==|`/g, '').trim();

/** The same word, or its stem: "completed" ~ "complete", "pretérito" ~ "preterite" — not "imperative" ~ "imperfect". */
function sameWord(x: string, w: string): boolean {
  if (x === w) return true;
  const n = Math.min(x.length, w.length);
  let i = 0;
  while (i < n && x[i] === w[i]) i++;
  return i >= 5 && i >= 0.8 * n;
}
/** Starts like the word but is another one ("imperative" for "imperfect"). */
const lookalike = (x: string, w: string) => x.length >= 5 && w.length >= 5 && x.slice(0, 5) === w.slice(0, 5) && !sameWord(x, w);

const TEX_SPAN = /\$[^$]+\$/g;
/** A key point's words, and its formulas (one letter, like "$a$", says too little to check). */
function partsOf(point: string) {
  return {
    words: contentWords(point.replace(TEX_SPAN, ' ')),
    formulas: (point.match(TEX_SPAN) ?? []).filter((m) => plainMath(m).length >= 2),
  };
}
/** Whether an answer has a formula in it, as LaTeX or written out. */
const hasMath = (answer: string, tex: string) =>
  normalizeTex(relations(answer)).includes(normalizeTex(relations(tex))) || plainMath(answer).includes(plainMath(tex));

/** Share of a key point found in the answer: its words (or their stems) and its formulas. */
export function coverage(point: string, answer: string): number {
  const { words, formulas } = partsOf(point);
  if (!words.length && !formulas.length) return 1;
  const aw = tokenize(answer);
  const found = words.filter((w) => aw.some((x) => sameWord(x, w))).length + formulas.filter((m) => hasMath(answer, m)).length;
  return found / (words.length + formulas.length);
}

/**
 * Whether the point's words come in the answer in the point's order: "the
 * preterite sets the scene and the imperfect interrupts it" has the notes'
 * words in each other's roles. Only words said once on each side can be placed.
 */
function sameOrder(point: string, answer: string): boolean {
  const pw = partsOf(point).words;
  const aw = tokenize(answer);
  let last = -1;
  for (const w of pw) {
    if (pw.filter((x) => sameWord(x, w)).length !== 1) continue;
    const at = aw.flatMap((x, i) => (sameWord(x, w) ? [i] : []));
    if (at.length !== 1) continue;
    if (at[0] < last) return false;
    last = at[0];
  }
  return true;
}

/** Whether an answer has a key in it: the key as written, or most of its words and formulas. */
export function hasKey(answer: string, key: string): boolean {
  const k = fold(strip(key));
  if (k && ` ${fold(strip(answer))} `.includes(` ${k} `)) return true;
  const { words, formulas } = partsOf(key);
  return (words.length > 0 || formulas.length > 0) && coverage(key, answer) >= 0.7;
}

const NEG = /\b(?:not|no|never|none|cannot|without)\b|n['’]t\b/i;

/**
 * Whether an answer has a key point: most of its words and formulas, its
 * words in its order, no look-alike in place of one of them, and no "not"
 * the point doesn't have.
 */
export function covers(answer: string, point: string): boolean {
  if (coverage(point, answer) < 0.7 || !sameOrder(point, answer) || (NEG.test(answer) && !NEG.test(point))) return false;
  const aw = tokenize(answer);
  return !partsOf(point).words.some((w) => !aw.some((x) => sameWord(x, w)) && aw.some((x) => lookalike(x, w)));
}

/**
 * The code path for a free answer: clearly right (every point covered),
 * clearly empty, or undecided (null — ask the grader).
 */
export function quickRubric(answer: string, points: string[]): Grade | null {
  if (isDontKnow(answer)) return { s: 0 };
  // A word or two says nothing — unless it names a point (the idea an example shows): then it's incomplete, not wrong.
  if (contentWords(answer).length < 2) return points.some((p) => coverage(p, answer) >= 0.7) ? null : { s: 0 };
  return points.every((p) => covers(answer, p)) ? { s: 1 } : null;
}

/** A short answer that names one of the points (the idea an example shows): incomplete, not a misconception. */
export function namesPoint(answer: string, points: string[]): boolean {
  return !isDontKnow(answer) && contentWords(answer).length < 2 && points.some((p) => coverage(p, answer) >= 0.7);
}

export interface GraderReply {
  points: { n: number; hit: 'yes' | 'partly' | 'no'; quote?: string }[];
  contradicts?: string;
}

/**
 * The model's rubric verdict, checked: a "yes" or "partly" counts only if
 * it quotes the student's own words and they share words with the point
 * beyond what the question shows; a contradiction counts only if it's really
 * in the answer. A grader that gives credit to an answer that shares almost
 * nothing with the notes is capped.
 */
export function scoreRubric(reply: GraderReply, points: string[], answer: string, fact: string, asked = ''): Grade {
  const a = strip(answer);
  const shown = contentWords(asked);
  const hits = points.map((p, i) => {
    const r = reply.points.find((x) => x.n === i + 1);
    let hit = r?.hit ?? 'no';
    if (hit !== 'no') {
      const q = strip(r?.quote ?? '');
      // The idea's name or the example, quoted back from the question, proves nothing.
      const own = contentWords(q).filter((w) => !shown.some((x) => sameWord(x, w)));
      const related = own.length > 0 && (own.some((w) => contentWords(p).includes(w)) || coverage(p, own.join(' ')) >= 0.3);
      // An unquoted "yes" is worth less; quoted words that aren't the student's, or have nothing to do with the point, prove nothing.
      if (!q) hit = hit === 'yes' ? 'partly' : 'no';
      else if (!a.includes(q) || !related) hit = 'no';
    }
    return hit;
  });
  let s = hits.reduce((n, h) => n + (h === 'yes' ? 1 : h === 'partly' ? 0.5 : 0), 0) / Math.max(1, points.length);
  const contra = strip(reply.contradicts ?? '');
  if (contra && a.includes(contra)) s = Math.max(0, s - 0.25);
  // Lenient grader: more than half credit for an answer that has almost nothing of the notes in it.
  const aw = contentWords(answer);
  const known = new Set(contentWords([...points, fact].join(' ')));
  if (s > 0.5 && aw.length >= 3 && aw.filter((w) => known.has(w)).length / aw.length < 0.1) s = 0.5;
  return { s: Math.round(s * 100) / 100 };
}

export type Verdict = 'right' | 'partial' | 'wrong';
export const verdictOf = (s: number): Verdict => (s >= 0.8 ? 'right' : s >= 0.5 ? 'partial' : 'wrong');
