import { GAP_RE, verifyAnswer, type VerifyCtx } from './verify';
import { parseGaps, withoutGapLines, type CoverageLevel } from './policy';

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
  // Nothing in it could be matched to the notes: the whole reply is the model's own knowledge.
  if (report.claims > 0 && report.supported + report.weak === 0 && report.outside === 0) {
    return {
      shown: `:::outside auto\n${body.replace(CITES, '').trim()}\n:::`,
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
