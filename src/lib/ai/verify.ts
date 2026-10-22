import { tokenize } from './rag';
import { isCitation, normalizeOutside, OWN_CLOSE, OWN_OPEN, WEAK_CLOSE, WEAK_OPEN } from './markdown';
import { needsCitation } from './grounding';
import { findQuote } from './quote';

/**
 * The notes-only check. Every statement in an answer that is supposed to come
 * from the student's notes is checked against the excerpt it cites, in code —
 * correctness must not depend on a small model obeying its instructions.
 *
 *   supported    cites an excerpt that says it (citation repaired if needed)
 *   weak         related to its excerpt but not clearly the same — flagged
 *   unsupported  no excerpt backs it, or it adds a name/number/rule the notes
 *                don't have, or it flips a negation — moved into a box
 *                labelled as the AI's own knowledge
 *   exempt       talks to the student, names a gap, or is already in a box
 *
 * Everything shown outside a box is therefore either backed by a cited
 * excerpt or a question/instruction to the student.
 */

export interface ExcerptRef {
  n: number;
  text: string;
  title?: string;
  section?: string;
  /** A picture the student attached (no text to check against unless it was transcribed). */
  visual?: boolean;
}

export type VerifyMode = 'explain' | 'compute';
export type Verdict = 'supported' | 'weak' | 'unsupported' | 'exempt';

export interface VerifyCtx {
  excerpts: Map<number, ExcerptRef>;
  /** The student's own question, work or selection — restating it is allowed. */
  context: string;
  /** `compute`: working the student's own problem (tutor/check/solve/homework) — derived numbers are allowed. */
  mode: VerifyMode;
  /** IDF weight of a token over the vault (rarer words weigh more). */
  idf?: (t: string) => number;
  /** Whether a token appears anywhere in the vault. */
  inVault?: (t: string) => boolean;
  /** Verdicts settled by the double-check pass (keyed by the statement's plain text). */
  overrides?: Map<string, { verdict: Verdict; cite?: number }>;
}

export interface StatementCheck {
  text: string;
  verdict: Verdict;
  /** A derivation line working the student's own numbers. */
  derived?: boolean;
  /** Unsupported only for lack of overlap (no invented name/number, no contradiction): a quoted passage can still rescue it. */
  rescuable?: boolean;
  support: number;
  /** Names, numbers, rules or quotes the cited notes don't contain. */
  novel: string[];
  cites: number[];
  repaired?: number;
}

export interface VerifyReport {
  /** Statements that make a claim (everything but exempt). */
  claims: number;
  supported: number;
  weak: number;
  /** Unsupported statements moved into an own-knowledge box. */
  contained: number;
  /** Boxes the model wrote itself. */
  outside: number;
  /** Citations Nib added or corrected. */
  repaired: number;
  /** Lines that work the student's own numbers (shown with "check the arithmetic"). */
  derived: number;
  statements: StatementCheck[];
  /** The answer with unsupported parts boxed, weak ones marked, citations repaired. */
  md: string;
}

const SUPPORTED_AT = 0.5;
const UNSUPPORTED_BELOW = 0.3;
const REPAIR_AT = 0.6;

const CITE_G = /\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\](?!\()/g;
export const GAP_RE =
  /(notes?|excerpts?|lecture|passage)s? (don['’]t|do not|doesn['’]t|does not|didn['’]t|never) (cover|mention|say|include|show|contain|explain|define|give|discuss)|not (covered|mentioned|defined|included|explained) (in|by) (your|the) (notes?|excerpts?)|\bnot in (your|the) notes\b|couldn['’]t find|isn['’]t in (your|the) notes|no (example|definition|method) (of this )?in (your|the) notes/i;
const NEGATION = /\b(not|no|never|none|cannot|without|nor|neither|nunca|jamás|tampoco)\b|n['’]t\b/i;

/** Words that talk about the notes rather than state anything. */
const TALK_WORDS = (
  'notes note your teacher professor prof says said according mention mentions mentioned also using use used step first then next here way lecture class remember means called excerpt excerpts ' +
  // filler and framing that carry no fact ("Your notes give this example: …")
  'both too each really actually basically simply just still even quite rather well need needs want give gives given show shows shown example examples case look exactly state states stated write written'
).split(' ');
// Matched after stemming too ("according" → "accord").
const NOTES_TALK = new Set([...TALK_WORDS, ...tokenize(TALK_WORDS.join(' '))]);

const SYNONYMS: Record<string, string> = {
  limit: 'lim',
  sine: 'sin',
  cosine: 'cos',
  tangent: 'tan',
  infinity: 'infty',
  logarithm: 'log',
  natural: 'ln',
  integral: 'int',
  sum: 'sum',
  approache: 'to',
  approach: 'to',
  tend: 'to',
};

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** Operators that carry a method (formatting ones like \\cdot or \\leq don't). */
const MATH_OPS = /\\(int|iint|oint|sum|prod|partial|nabla|log|ln|exp|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|lim|infty|sqrt|det|binom|vec)(?![a-zA-Z])/g;

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

const canon = (t: string) => SYNONYMS[t] ?? t;

/** Text of a statement without markdown decoration and citation markers. */
export function plainText(s: string): string {
  return s
    .replace(CITE_G, '')
    .replace(/[\uE000-\uE003]/g, '')
    .replace(/\*\*|__|==|`/g, '')
    .replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$|[.,;:!?])/g, '$1')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content tokens used for support: no stop words, no talk about the notes. */
function contentTokens(text: string): string[] {
  return [...new Set(tokenize(text).map(canon))].filter((w) => (w.length > 2 || /\d/.test(w)) && !NOTES_TALK.has(w));
}

/**
 * IDF-weighted share of a statement's content words found in the sources
 * (0–1). Word forms match on a 5-letter prefix ("continuous"/"continuity").
 */
export function idfSupport(text: string, sources: string, idf?: (t: string) => number): { support: number; missing: string[] } {
  const words = contentTokens(text);
  if (!words.length) return { support: 1, missing: [] };
  const src = new Set(tokenize(sources).map(canon));
  const prefixes = new Set([...src].filter((t) => t.length >= 6).map((t) => t.slice(0, 5)));
  let have = 0;
  let total = 0;
  const missing: string[] = [];
  for (const w of words) {
    const weight = Math.max(0.2, idf ? idf(w) : 1);
    total += weight;
    if (src.has(w) || (w.length >= 6 && prefixes.has(w.slice(0, 5)))) have += weight;
    else missing.push(w);
  }
  return { support: total ? have / total : 1, missing };
}

/** Math segments ($…$, $$…$$, \(…\)) of a statement. */
function mathSegments(s: string): string[] {
  return s.match(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g) ?? [];
}

/**
 * The parts of a statement that are easy to invent and easy to check:
 * numbers, names (capitalised words mid-sentence, acronyms), quoted phrases
 * and math operators.
 */
export function criticalTokens(statement: string, mode: VerifyMode = 'explain'): string[] {
  const out: string[] = [];
  const math = mathSegments(statement);
  // Derived numbers are allowed when working a problem: numbers inside an equation.
  let prose = statement;
  for (const m of math) prose = prose.replace(m, mode === 'compute' && /[=<>≤≥]|\\(?:to|leq|geq|approx)/.test(m) ? ' ' : ` ${m} `);
  // Numbers, except list/step references ("Step 2", "(3)", "Problem 4") and citation-like brackets.
  const numbered = prose
    .replace(/\b(?:step|steps|problem|problems|question|questions|part|parts|example|ex|lecture|chapter|unit|section|page|line|item|#)\s*\d+[a-z]?\b/gi, ' ')
    .replace(/\(\d{1,2}\)/g, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ');
  for (const n of numbered.match(/\d+(?:[.,]\d+)?/g) ?? []) out.push(`#${n.replace(',', '.')}`);
  // Names: capitalised words that don't start a sentence or clause.
  const words = [...prose.matchAll(/(^|[^\p{L}\p{N}'’])(\p{Lu}[\p{L}'’-]*)/gu)];
  for (const m of words) {
    const w = m[2].replace(/['’]s$/, '');
    if (w.length < 2 || w === 'I') continue;
    const before = prose.slice(0, m.index! + m[1].length).trimEnd();
    if (!before || /[.!?:;¿¡"“(\-—–*>]$/.test(before)) continue;
    out.push(`w:${w}`);
  }
  for (const q of statement.match(/[“"]([^”"]{6,80})[”"]/g) ?? []) {
    const inner = q.slice(1, -1).trim();
    if (inner.split(/\s+/).length >= 2) out.push(`q:${inner}`);
  }
  for (const m of prose.matchAll(MATH_OPS)) out.push(`op:${m[1]}`);
  return [...new Set(out)];
}

/** Critical tokens of a statement that appear in neither the sources nor the student's own text. */
export function novelTokens(statement: string, sources: string, mode: VerifyMode = 'explain'): string[] {
  const crit = criticalTokens(statement, mode).filter((c) => c !== '#' && c.length > 1);
  if (!crit.length) return [];
  const folded = fold(sources);
  const srcTokens = new Set(tokenize(sources));
  const numbers = new Set((sources.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.')));
  return crit.filter((c) => {
    const v = c.slice(c.indexOf(':') + 1);
    if (c.startsWith('#')) {
      const n = c.slice(1);
      if (numbers.has(n)) return false;
      const i = Number(n);
      return !(Number.isInteger(i) && i <= 12 && new RegExp(`\\b${NUMBER_WORDS[i]}\\b`, 'i').test(sources));
    }
    if (c.startsWith('w:')) {
      const t = tokenize(v)[0];
      return !(folded.includes(fold(v)) || (t && srcTokens.has(t)));
    }
    if (c.startsWith('q:')) return !fold(sources.replace(/\s+/g, ' ')).includes(fold(v.replace(/\s+/g, ' ')));
    if (c.startsWith('op:')) return !(sources.includes(`\\${v}`) || new RegExp(`\\b${v}\\b`, 'i').test(sources));
    return false;
  });
}

/** Words a negation applies to: the next few content words after "not", "no", "never"… */
function negatedTerms(text: string): Set<string> {
  const out = new Set<string>();
  const parts = text.split(NEGATION_SPLIT);
  for (let i = 1; i < parts.length; i++) for (const t of contentTokens(parts[i]).slice(0, 2)) out.add(t);
  return out;
}
const NEGATION_SPLIT = /\b(?:not|no|never|none|cannot|without|nor|neither|nunca|jamás|tampoco)\b|n['’]t\b/i;

/**
 * The statement denies something the notes affirm ("…and the limit does not
 * exist" against "the limit exists"): a contradiction dressed in the notes' words.
 */
function negationFlip(statement: string, sources: string): boolean {
  if (!NEGATION.test(statement)) return false;
  const denied = negatedTerms(statement);
  const srcDenied = negatedTerms(sources);
  const src = new Set(tokenize(sources).map(canon));
  return [...denied].some((t) => src.has(t) && !srcDenied.has(t));
}

function excerptText(e: ExcerptRef): string {
  return [e.title, e.section, e.text].filter(Boolean).join('\n');
}

/** Judges one statement (its own text and the excerpts it cites). */
export function checkStatement(raw: string, cites: number[], ctx: VerifyCtx): StatementCheck {
  const text = plainText(raw);
  const valid = cites.filter((n) => ctx.excerpts.has(n));
  const notesFor = (ns: number[]) => ns.map((n) => excerptText(ctx.excerpts.get(n)!)).join('\n');
  // The student's own words may supply numbers and names (their problem), but never evidence for a fact:
  // asking about "the power rule" must not make a claim about the power rule look supported.
  const sourcesFor = (ns: number[]) => [notesFor(ns), ctx.context].join('\n');
  const result = (verdict: Verdict, support: number, novel: string[], repaired?: number): StatementCheck => ({
    text,
    verdict,
    support,
    novel,
    cites: repaired ? [repaired] : valid,
    repaired,
  });

  if (!text || GAP_RE.test(text)) return result('exempt', 1, []);
  const settled = ctx.overrides?.get(text);
  if (settled) return result(settled.verdict, 1, [], settled.cite && !valid.includes(settled.cite) ? settled.cite : undefined);
  // A picture the student attached can't be checked word for word; what it shows is their own work.
  const visualOnly = valid.length > 0 && valid.every((n) => ctx.excerpts.get(n)!.visual && !ctx.excerpts.get(n)!.text.trim());

  const judge = (ns: number[], opts: { rare?: boolean } = {}) => {
    const src = ns.length ? notesFor(ns) : ctx.context;
    const { support, missing } = idfSupport(text, src, ctx.idf);
    const novel = novelTokens(text, sourcesFor(ns), ctx.mode);
    // Words that appear nowhere in the student's notes are the clearest sign of outside knowledge.
    const rare = ctx.inVault && opts.rare !== false ? missing.filter((t) => t.length >= 4 && !ctx.inVault!(t)).length : 0;
    const flip = support >= 0.4 && negationFlip(text, src);
    let verdict: Verdict = 'supported';
    if (novel.length || flip || support < UNSUPPORTED_BELOW || rare >= 2 || (rare && support < 0.4)) verdict = 'unsupported';
    else if (support < SUPPORTED_AT || rare) verdict = 'weak';
    return { verdict, support, novel, rescuable: verdict === 'unsupported' && !novel.length && !flip && support >= 0.2 };
  };

  // Hand-offs and questions to the student ("What is left if you substitute x = 3?") need no source —
  // unless they slip in a name or number that appears in none of the excerpts.
  if (!needsCitation(text)) {
    const novel = novelTokens(text, sourcesFor([...ctx.excerpts.keys()]), ctx.mode);
    if (!novel.length) return result('exempt', 1, []);
  }
  // Pure derivation lines when working a problem ($3+3=6$): the method is cited elsewhere.
  if (ctx.mode === 'compute') {
    const prose = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, ' ');
    if (contentTokens(prose).length < 3 && mathSegments(text).length && !novelTokens(text, sourcesFor(valid), ctx.mode).length)
      return { ...result('exempt', 1, []), derived: true };
  }
  if (visualOnly) {
    const novel = novelTokens(text, ctx.context, ctx.mode);
    return result(novel.length ? 'weak' : 'supported', 1, novel);
  }

  const own = valid.length ? judge(valid) : null;
  if (own && own.verdict === 'supported') return result('supported', own.support, own.novel);
  // Restating the student's own problem ("You're finding $\\lim …$") needs no source — only when
  // working a problem, and only if it says nothing the problem doesn't.
  const loose = judge([], { rare: false });
  if (!valid.length && ctx.mode === 'compute' && loose.support >= 0.8 && !loose.novel.length && ctx.context.trim())
    return result('exempt', loose.support, []);
  // Citation repair: the model cited nothing, or the wrong excerpt.
  let best: { n: number; support: number; novel: string[] } | null = null;
  for (const [n, e] of ctx.excerpts) {
    if (e.visual || valid.includes(n)) continue;
    const j = judge([n]);
    if (j.verdict === 'supported' && j.support >= REPAIR_AT && (!best || j.support > best.support)) best = { n, support: j.support, novel: j.novel };
  }
  if (best) return result('supported', best.support, best.novel, best.n);
  if (own) return { ...result(own.verdict, own.support, own.novel), rescuable: own.rescuable };
  return result('unsupported', loose.support, loose.novel);
}

// ------------------------------------------------------------------ markdown structure

type BlockKind = 'para' | 'item' | 'quote' | 'table' | 'heading' | 'code' | 'outside' | 'math' | 'blank' | 'rule' | 'gap';
interface Block {
  kind: BlockKind;
  lines: string[];
}

const ITEM_RE = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+/;
const GAP_LINE = /^\s*\**\s*not in (?:your |the )?notes\s*\**\s*:?/i;

function parseBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) =>
    !l.trim() ||
    /^\s*```/.test(l) ||
    /^:::/.test(l) ||
    /^\s*\$\$/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    ITEM_RE.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*\|/.test(l) ||
    /^\s*(?:---|\*\*\*|___)\s*$/.test(l) ||
    GAP_LINE.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      out.push({ kind: 'blank', lines: [l] });
      i++;
    } else if (/^\s*```/.test(l)) {
      const start = i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
      out.push({ kind: 'code', lines: lines.slice(start, Math.min(++i, lines.length)) });
    } else if (/^:::outside/.test(l)) {
      const start = i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) i++;
      out.push({ kind: 'outside', lines: lines.slice(start, Math.min(++i, lines.length)) });
    } else if (/^\s*\$\$/.test(l)) {
      const start = i;
      const rest = l.trim().slice(2);
      if (!rest.includes('$$')) {
        i++;
        while (i < lines.length && !lines[i].includes('$$')) i++;
      }
      out.push({ kind: 'math', lines: lines.slice(start, Math.min(++i, lines.length)) });
    } else if (/^#{1,6}\s/.test(l)) {
      out.push({ kind: 'heading', lines: [l] });
      i++;
    } else if (GAP_LINE.test(l)) {
      out.push({ kind: 'gap', lines: [l] });
      i++;
    } else if (/^\s*(?:---|\*\*\*|___)\s*$/.test(l)) {
      out.push({ kind: 'rule', lines: [l] });
      i++;
    } else if (ITEM_RE.test(l)) {
      const start = i++;
      while (i < lines.length && !startsBlock(lines[i])) i++;
      out.push({ kind: 'item', lines: lines.slice(start, i) });
    } else if (/^\s*>/.test(l)) {
      out.push({ kind: 'quote', lines: [l] });
      i++;
    } else if (/^\s*\|/.test(l)) {
      out.push({ kind: 'table', lines: [l] });
      i++;
    } else {
      const start = i++;
      while (i < lines.length && !startsBlock(lines[i])) i++;
      out.push({ kind: 'para', lines: lines.slice(start, i) });
    }
  }
  return out;
}

const ABBREV = /(?:\b(?:e\.g|i\.e|vs|etc|dr|prof|ex|fig|no|sra|sr|mr|mrs|ms|approx|cf|st|p|pp|vol)|\b\p{L})\.$/iu;

/**
 * Splits a paragraph into sentences without breaking math, decimals or
 * abbreviations. Citations after the full stop stay with their sentence.
 * Returns exact substrings, so the paragraph can be reassembled.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inMath = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '$' && text[i - 1] !== '\\') {
      if (text[i + 1] === '$') i++;
      inMath = !inMath;
      continue;
    }
    if (inMath) continue;
    if (c === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
      continue;
    }
    if (!/[.!?]/.test(c)) continue;
    let j = i + 1;
    while (j < text.length && /["”’)\]*]/.test(text[j]) && !(text[j] === '[' || /\d/.test(text[j]))) j++;
    // Trailing citations belong to the sentence: "… = L. [2][3]"
    for (;;) {
      const m = /^\s*\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\]/.exec(text.slice(j));
      if (!m) break;
      j += m[0].length;
    }
    const ws = /^[ \t]+/.exec(text.slice(j));
    if (!ws) continue;
    const next = text[j + ws[0].length];
    if (!next || !/[\p{Lu}¿¡"“(*$\\\d]/u.test(next)) continue;
    if (c === '.' && ABBREV.test(text.slice(Math.max(0, i - 6), i + 1))) continue;
    out.push(text.slice(start, j + ws[0].length));
    start = j + ws[0].length;
    i = start - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.length);
}

function citesIn(s: string, maxCite: number): number[] {
  const masked = s.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => ' '.repeat(m.length));
  const out: number[] = [];
  for (const m of masked.matchAll(CITE_G)) {
    if (!isCitation(masked, m.index!, m[1], maxCite)) continue;
    for (const part of m[1].split(/\s*,\s*/)) {
      const r = part.split(/\s*[–-]\s*/).map(Number);
      if (r.length === 2) for (let n = r[0]; n <= r[1]; n++) out.push(n);
      else out.push(r[0]);
    }
  }
  return out;
}

function stripCites(s: string, maxCite: number): string {
  const masked = s.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => '\u0001'.repeat(m.length));
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(CITE_G)) {
    if (!isCitation(masked, m.index!, m[1], maxCite)) continue;
    out += s.slice(last, m.index).replace(/[ \t]+$/, '');
    last = m.index! + m[0].length;
  }
  return out + s.slice(last);
}

/** Adds (or swaps in) the repaired citation, keeping the sentence's own spacing. */
function withCitation(s: string, n: number, maxCite: number): string {
  const body = stripCites(s, maxCite);
  const m = /(\s*)$/.exec(body)!;
  return `${body.slice(0, body.length - m[1].length)} [${n}]${m[1]}`;
}

/**
 * Checks a whole answer and rewrites it: unsupported sentences of a
 * paragraph move into `:::outside auto` boxes in place; an unsupported list
 * item, quote line or table row is marked inline (so lists stay intact);
 * weak statements are marked; citations are repaired.
 */
export function verifyAnswer(raw: string, ctx: VerifyCtx): VerifyReport {
  const md = normalizeOutside(raw);
  const maxCite = Math.max(0, ...ctx.excerpts.keys());
  const report: VerifyReport = { claims: 0, supported: 0, weak: 0, contained: 0, outside: 0, repaired: 0, derived: 0, statements: [], md: '' };
  const count = (c: StatementCheck) => {
    report.statements.push(c);
    if (c.derived) report.derived++;
    if (c.verdict === 'exempt') return;
    report.claims++;
    if (c.verdict === 'supported') report.supported++;
    else if (c.verdict === 'weak') report.weak++;
    else report.contained++;
    if (c.repaired) report.repaired++;
  };
  const out: string[] = [];
  let pending: string[] = []; // unsupported sentences waiting to be boxed
  let lastVerdict: Verdict = 'exempt';
  const flushBox = () => {
    if (!pending.length) return;
    out.push(':::outside auto', pending.join('').trim(), ':::', '');
    pending = [];
  };
  const blocks = parseBlocks(md);
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    switch (block.kind) {
      case 'para': {
        const paraOut: string[] = [];
        if (pending.length) pending.push('\n\n');
        for (const s of splitSentences(block.lines.join('\n'))) {
          const c = checkStatement(s, citesIn(s, maxCite), ctx);
          count(c);
          lastVerdict = c.verdict;
          if (c.verdict === 'unsupported') {
            if (paraOut.length) {
              flushBox();
              out.push(paraOut.join('').trimEnd(), '');
              paraOut.length = 0;
            }
            pending.push(stripCites(s, maxCite));
            continue;
          }
          if (pending.length) {
            flushBox();
            out.push('');
          }
          let t = c.repaired ? withCitation(s, c.repaired, maxCite) : s;
          if (c.verdict === 'weak') t = `${WEAK_OPEN}${t.trimEnd()}${WEAK_CLOSE}${/\s$/.test(t) ? ' ' : ''}`;
          paraOut.push(t);
        }
        if (paraOut.length) {
          flushBox();
          out.push(paraOut.join('').trimEnd());
        }
        break;
      }
      case 'item':
      case 'quote':
      case 'table': {
        flushBox();
        const first = block.lines[0];
        const prefix = block.kind === 'item' ? (/^(\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(first)?.[1] ?? '') : block.kind === 'quote' ? (/^\s*>\s?/.exec(first)?.[0] ?? '') : '';
        const body = [first.slice(prefix.length), ...block.lines.slice(1)].join('\n');
        if (block.kind === 'table' && /^\s*\|?[\s:|-]+\|?\s*$/.test(first)) {
          out.push(first);
          break;
        }
        const c = checkStatement(body, citesIn(body, maxCite), ctx);
        count(c);
        lastVerdict = c.verdict;
        if (c.verdict === 'unsupported') out.push(`${prefix}${OWN_OPEN}${stripCites(body, maxCite).trim()}${OWN_CLOSE}`);
        else if (c.verdict === 'weak') out.push(`${prefix}${WEAK_OPEN}${body.trim()}${WEAK_CLOSE}`);
        else out.push(`${prefix}${c.repaired ? withCitation(body, c.repaired, maxCite) : body}`);
        break;
      }
      case 'math':
        // Display math goes with the sentence that introduced it.
        if (lastVerdict === 'unsupported' && (pending.length || out[out.length - 1] === ':::')) {
          if (!pending.length && out[out.length - 1] === ':::') {
            out.pop();
            pending.push(out.pop() ?? '');
          }
          pending.push(`\n\n${block.lines.join('\n')}\n`);
        } else {
          flushBox();
          out.push(...block.lines);
        }
        break;
      case 'outside':
        flushBox();
        report.outside++;
        out.push(block.lines[0], ...block.lines.slice(1).map((l) => (/^:::\s*$/.test(l) ? l : stripCites(l, maxCite))));
        break;
      case 'blank':
        // A blank line ends a paragraph; boxes merge across it.
        if (pending.length) break;
        out.push('');
        break;
      default:
        flushBox();
        out.push(...block.lines);
    }
  }
  flushBox();
  report.md = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return report;
}

/** Copy/history version of a checked answer: inline markers become words. */
export function markersToText(md: string): string {
  return md
    .replace(new RegExp(OWN_OPEN, 'g'), '')
    .replace(new RegExp(OWN_CLOSE, 'g'), ' _(not from your notes)_')
    .replace(/[\uE002\uE003]/g, '');
}

/**
 * What the model sees of its earlier answers: no boxes (unverified text must
 * not come back as established fact) and no [n] (the numbers change every turn).
 */
export function historyForModel(md: string): string {
  return normalizeOutside(md)
    .replace(/^:::outside[^\n]*\n[\s\S]*?\n:::\s*$/gm, '(A part from general knowledge was left out.)')
    .replace(/\uE000[\s\S]*?\uE001/g, '(left out — not from the notes)')
    .replace(/[\uE002\uE003]/g, '')
    .replace(/\s*\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\](?!\()/g, '')
    .trim();
}

/**
 * Rewrites and translations reword the student's own passage, so nothing in
 * them needs a citation — but they must not add names, numbers or formulas
 * the passage doesn't have. Returns what was added.
 */
export function transformCheck(passage: string, output: string): string[] {
  return novelTokens(output, passage, 'explain')
    .filter((t) => !t.startsWith('q:'))
    .map((t) => t.slice(t.indexOf(':') + 1).replace(/^#/, ''))
    .slice(0, 6);
}

/** The double-check prompt: the model must quote the excerpt that says each statement (verified in code). */
export const VERIFY_PROMPT = (statements: string[]) => `Check your answer against the excerpts. For each numbered statement, copy the exact words from ONE excerpt that say the same thing. If no excerpt says it, write "none".
${statements.map((st, i) => `${i + 1}. ${st}`).join('\n')}
Respond with JSON only: {"checks":[{"n":1,"excerpt":2,"quote":"exact words copied from that excerpt"}]}`;

/**
 * Settles loosely matched statements with the model's quotes — but only
 * code can promote one: the quote must really be in that excerpt (at least
 * five words) and say much the same thing. Everything else is boxed.
 */
export function settleWeak(
  statements: string[],
  checks: { n: number; excerpt: number; quote: string }[],
  excerpts: Map<number, ExcerptRef>,
  idf?: (t: string) => number,
): Map<string, { verdict: Verdict; cite?: number }> {
  const out = new Map<string, { verdict: Verdict; cite?: number }>();
  statements.forEach((st, i) => {
    const c = checks.find((x) => x.n === i + 1);
    const e = c && excerpts.get(c.excerpt);
    const quote = c?.quote ?? '';
    // The quote must really be in that passage; the passage's own line (with its heading) is what's compared.
    const line = e && !e.visual && (quote.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 5 ? findQuote(quote, e.text) : null;
    const ok = !!line && idfSupport(st, `${e!.title ?? ''} ${e!.section ?? ''} ${line}`, idf).support >= 0.4 && !novelTokens(st, e!.text).length;
    out.set(st, ok ? { verdict: 'supported', cite: c!.excerpt } : { verdict: 'unsupported' });
  });
  return out;
}
