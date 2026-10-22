import { tokenize } from '../ai/rag';
import { contentWords } from './concepts';

/**
 * Grading. Typed answers are graded by code against the note's own words,
 * forgiving the slips that don't show a gap in knowledge (and saying so).
 * Free answers are graded against verbatim key points: by code when the
 * answer clearly contains them, otherwise by the model — whose verdict must
 * quote the student's own words, or it doesn't count.
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
    .replace(/\*\*|==|`|_/g, '')
    .toLowerCase()
    .replace(/[“”"'‘’.,;:!?¿¡()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '');

export function normalizeTex(s: string): string {
  return s
    .trim()
    .replace(/^\$+|\$+$/g, '')
    .replace(/\\left|\\right|\\[,!;:]|\\d?frac/g, (m) => (/frac/.test(m) ? '\\frac' : ''))
    .replace(/\\cdot/g, '*')
    .replace(/\s+/g, '')
    .replace(/\{(\w)\}/g, '$1');
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

/**
 * A typed answer against the note's answer. In language classes accents and
 * articles are part of the answer (partial credit with a note); elsewhere a
 * spelling slip is forgiven.
 */
export function gradeShort(answer: string, key: string, opts: { accept?: string[]; language?: boolean } = {}): Grade {
  if (isDontKnow(answer)) return { s: 0 };
  const a = strip(answer);
  const keys = [key, ...(opts.accept ?? [])].map(strip).filter(Boolean);
  const k = strip(key);
  if (keys.includes(a)) return { s: 1 };
  // Math: compare the LaTeX itself.
  if (/[\\$^_{}]/.test(key) && [key, ...(opts.accept ?? [])].some((x) => normalizeTex(x) === normalizeTex(answer))) return { s: 1 };
  // A list ("-é, -aste, -ó, -amos, -aron"): order doesn't matter; partial lists get partial credit.
  const parts = (x: string) =>
    x
      .split(/\s*[,;/]\s*|\s+and\s+|\s+y\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  const kp = parts(stripKeepDashes(key));
  if (kp.length >= 3) {
    const ap = parts(stripKeepDashes(answer));
    const hit = kp.filter((p) => ap.some((x) => x === p || (!opts.language && fold(x) === fold(p)))).length;
    const accentHit = kp.filter((p) => ap.some((x) => fold(x) === fold(p))).length;
    const frac = hit / kp.length;
    if (frac >= 0.8) return { s: 1 };
    if (opts.language && accentHit / kp.length >= 0.8) return { s: 0.8, note: `Check the accents: “${clean(key)}”` };
    if (frac > 0) return { s: Math.round(frac * 100) / 100, note: `Your notes list: ${clean(key)}` };
  }
  const language = opts.language || /[áéíóúñü¿¡]/i.test(key);
  if (language) {
    if (keys.some((x) => fold(x) === fold(a))) return { s: 0.8, note: `Check the accent: “${clean(key)}”` };
    if (ARTICLES.test(k) && keys.some((x) => x.replace(ARTICLES, '') === a)) return { s: 0.8, note: `Include the article: “${clean(key)}”` };
    if (k.length >= 5 && levenshtein(fold(a), fold(k)) === 1) return { s: 0.8, note: `Watch the spelling: “${clean(key)}”` };
  } else {
    const tol = Math.max(1, Math.floor(k.length / 6));
    if (keys.some((x) => fold(x) === fold(a) || (x.length >= 4 && levenshtein(fold(a), fold(x)) <= tol))) return { s: 1, note: `(spelling: “${clean(key)}”)` };
  }
  return { s: 0 };
}

const stripKeepDashes = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/\*\*|==|`/g, '')
    .toLowerCase()
    .replace(/[“”"'‘’.;:!?¿¡()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const clean = (s: string) => s.replace(/\*\*|==|`/g, '').trim();

/** Share of a key point's content words found in the answer (5-letter prefix match). */
export function coverage(point: string, answer: string): number {
  const pw = contentWords(point);
  if (!pw.length) return 1;
  const aw = tokenize(answer);
  const has = (w: string) => aw.some((x) => x === w || (x.length >= 5 && w.length >= 5 && x.slice(0, 5) === w.slice(0, 5)));
  return pw.filter(has).length / pw.length;
}

const NEG = /\b(?:not|no|never|none|cannot|without)\b|n['’]t\b/i;

/**
 * The code path for a free answer: clearly right (every point covered, no
 * contradiction), clearly empty, or undecided (null — ask the grader).
 */
export function quickRubric(answer: string, points: string[]): Grade | null {
  if (isDontKnow(answer) || contentWords(answer).length < 2) return { s: 0 };
  const cov = points.map((p) => coverage(p, answer));
  if (cov.every((c) => c >= 0.7) && !points.some((p) => NEG.test(answer) && !NEG.test(p))) return { s: 1 };
  return null;
}

export interface GraderReply {
  points: { n: number; hit: 'yes' | 'partly' | 'no'; quote?: string }[];
  contradicts?: string;
}

/**
 * The model's rubric verdict, checked: a "yes" or "partly" counts only if
 * it quotes the student's own words and they share words with the point; a
 * contradiction counts only if it's really in the answer. A grader that says
 * "yes" to an answer that shares almost nothing with the notes is capped.
 */
export function scoreRubric(reply: GraderReply, points: string[], answer: string, fact: string): Grade {
  const a = strip(answer);
  const hits = points.map((p, i) => {
    const r = reply.points.find((x) => x.n === i + 1);
    let hit = r?.hit ?? 'no';
    if (hit !== 'no') {
      const q = strip(r?.quote ?? '');
      const inAnswer = !!q && a.includes(q);
      const related = contentWords(q).some((w) => contentWords(p).includes(w)) || coverage(p, q) >= 0.3;
      // Quoted words that have nothing to do with the point prove nothing; an unquoted "yes" is worth less.
      if (inAnswer && !related) hit = 'no';
      else if (!inAnswer) hit = hit === 'yes' ? 'partly' : 'no';
    }
    return hit;
  });
  let s = hits.reduce((n, h) => n + (h === 'yes' ? 1 : h === 'partly' ? 0.5 : 0), 0) / Math.max(1, points.length);
  const contra = strip(reply.contradicts ?? '');
  if (contra && a.includes(contra)) s = Math.max(0, s - 0.25);
  // Lenient grader: "all yes" for an answer that has almost nothing of the notes in it.
  const aw = contentWords(answer);
  const known = new Set(contentWords([...points, fact].join(' ')));
  if (s === 1 && aw.length >= 3 && aw.filter((w) => known.has(w)).length / aw.length < 0.1) s = 0.5;
  return { s: Math.round(s * 100) / 100 };
}

export type Verdict = 'right' | 'partial' | 'wrong';
export const verdictOf = (s: number): Verdict => (s >= 0.8 ? 'right' : s >= 0.5 ? 'partial' : 'wrong');
