import { GAP_RE, verifyAnswer, type VerifyCtx } from './verify';
import { parseGaps, withoutGapLines, type CoverageLevel } from './policy';
import { boxBody, normalizeOutside } from './markdown';

/** Why an answer carries a notice above it. */
export type Banner = 'none' | 'noneOff' | 'noLinked' | 'partial' | 'collapsed' | 'mayCover' | 'noExample';

export interface CheckSummary {
  claims: number;
  supported: number;
  weak: number;
  contained: number;
  outside: number;
  repaired: number;
  /** Lines that work the student's own numbers. */
  derived?: number;
  /** Statements the double-check settled (promoted or boxed). */
  settled?: number;
}

export interface Finished {
  /** What is shown (and inserted/copied): unsupported parts boxed, citations repaired. */
  shown: string;
  check: CheckSummary;
  /** What the model said the notes don't contain. */
  gaps: string[];
  coverage: CoverageLevel;
  banner?: Banner;
  /** Loosely matched statements (for the double-check). */
  weak: string[];
}

const CITES = /\s*\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\](?!\()/g;

/** The text without citation markers — never touching math, where "[0, 1]" is an interval. */
function withoutCites(s: string): string {
  const math: string[] = [];
  return s
    .replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => `\u0001${math.push(m) - 1}\u0001`)
    .replace(CITES, '')
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => math[Number(i)]);
}

/**
 * Turns a grounded reply into what the student sees. Runs in code after every
 * answer (and again after Continue), so the guarantee never depends on the
 * model: everything outside a box was checked against a cited excerpt.
 */
export function finishGrounded(raw: string, ctx: VerifyCtx, opts: { question?: string } = {}): Finished {
  const gaps = parseGaps(raw);
  const body = withoutGapLines(raw);
  const report = verifyAnswer(body, ctx);
  const check: CheckSummary = {
    claims: report.claims,
    supported: report.supported,
    weak: report.weak,
    contained: report.contained,
    outside: report.outside,
    repaired: report.repaired,
    derived: report.derived || undefined,
    settled: ctx.overrides?.size || undefined,
  };
  // A plain refusal ("Your notes don't cover this.") with nothing from the notes: the whole question is the gap.
  if (!gaps.length && report.supported + report.weak === 0 && !report.outside && opts.question && GAP_RE.test(body)) gaps.push(opts.question);
  // Nothing in it could be matched to the notes: the whole reply is the model's own knowledge. (Talk with the
  // student boxed only for its words — "Nice work!" — is no reason to box all of it.)
  const claims = report.statements.filter((st) => st.verdict !== 'exempt' && !st.talk).length;
  if (claims > 0 && report.supported + report.weak === 0 && report.outside === 0) {
    return {
      shown: `:::outside auto\n${boxBody(withoutCites(body))}\n:::`,
      check,
      gaps,
      coverage: 'none',
      banner: 'collapsed',
      weak: [],
    };
  }
  const anyFromNotes = report.supported + report.weak > 0;
  const coverage: CoverageLevel = !anyFromNotes && gaps.length ? 'none' : gaps.length || report.contained || report.outside ? 'partial' : 'full';
  return {
    shown: report.md,
    check,
    gaps,
    coverage,
    banner: coverage === 'none' ? 'none' : coverage === 'partial' ? 'partial' : undefined,
    // Loosely matched, or cited but unmatched for lack of overlap alone: the double-check can settle these.
    weak: report.statements.filter((st) => st.verdict === 'weak' || st.rescuable).map((st) => st.text),
  };
}

/** What a reply needs for `shownOf`. */
export interface ShownReply {
  content: string;
  shown?: string;
  ownOnly?: boolean;
  grounding?: string;
  status?: string;
}

/**
 * The markdown a reply shows, copies, inserts and sends back as history: the
 * checked version. A grounded reply that stopped or failed before it was
 * checked is boxed as unchecked — raw model text is never shown as an answer.
 */
export function shownOf(m: ShownReply): string {
  if (m.shown !== undefined) return m.shown;
  // The notes don't cover it: the reply streams straight into the labelled box.
  if (m.ownOnly && m.content) return `:::outside\n${boxBody(m.content)}\n:::`;
  if (m.content && m.grounding && m.grounding !== 'transform' && (m.status === 'stopped' || m.status === 'error'))
    return `:::outside auto\n${boxBody(withoutCites(m.content))}\n:::`;
  return m.content;
}

/** With "never use the AI's own knowledge": what isn't from the notes is left out, not shown in a box. */
export function leaveOutOwn(md: string): string {
  return normalizeOutside(md)
    .replace(/^:::outside[^\n]*\n[\s\S]*?\n:::[ \t]*$/gm, '_Left out — not in your notes._')
    // A table row's cells but the last close without a tag: they go, and the row says it once (its pipes stay).
    .replace(/\uE000[^\uE000\uE001\uE004]*\uE004/g, '')
    .replace(/\uE000[^\uE000\uE001]*\uE001/g, '_(left out — not in your notes)_')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
