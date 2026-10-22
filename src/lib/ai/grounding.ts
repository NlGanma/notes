import { tokenize } from './rag';

/**
 * Grounding check for answers that must come from the student's notes
 * (homework, Ask your notes). Small local models sometimes cite the wrong
 * excerpt or slip in a claim with no citation; we can't prove an answer is
 * right, but we can show the student exactly which statements are backed by
 * which note, which aren't, and which are general knowledge.
 */

export interface GroundingReport {
  /** Statements with at least one citation. */
  cited: number;
  /** Statements that make a claim but cite nothing (outside a general-knowledge box). */
  uncited: number;
  /** General-knowledge boxes. */
  outside: number;
  /** Citations whose sentence shares little with the cited excerpt. */
  weak: number;
}

/** Share of a statement's content words that appear in the excerpt (0–1). */
export function supportScore(statement: string, excerpt: string): number {
  const words = [...new Set(tokenize(statement))].filter((w) => w.length > 2 || /\d/.test(w));
  if (words.length < 4) return 1;
  const src = new Set(tokenize(excerpt));
  return words.filter((w) => src.has(w)).length / words.length;
}

const WEAK_BELOW = 0.18;

/** Sentences that talk to the student, or say what the notes lack, need no citation. */
export function needsCitation(text: string): boolean {
  const t = text.trim();
  if (t.length < 28) return false;
  if (/\?\s*$/.test(t)) return false;
  if (
    /(notes?|excerpts?) (don['’]t|do not|doesn['’]t|does not|didn['’]t|never) (cover|mention|say|include|show|contain|explain|define)|not (covered|mentioned|in your notes)|couldn['’]t find/i.test(
      t,
    )
  )
    return false;
  if (/^(try|now|next|your turn|give it a try|can you|what do you|see if|ask your|check with|let me know|tell me|good luck|remember to|want me)/i.test(t))
    return false;
  return true;
}

/** Plain text of a rendered element, with KaTeX replaced by its LaTeX source. */
export function textWithTex(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.katex').forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
    k.replaceWith(document.createTextNode(` ${tex} `));
  });
  clone.querySelectorAll('.cite').forEach((c) => c.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Marks up a rendered answer in place: `.uncited` on statements without a
 * citation, `.is-weak` on citations that don't match their excerpt.
 */
export function applyGrounding(root: HTMLElement, excerptFor: (n: number) => string | undefined): GroundingReport {
  const report: GroundingReport = { cited: 0, uncited: 0, outside: root.querySelectorAll('.outside-notes').length, weak: 0 };
  const statements = [...root.querySelectorAll('p, li')].filter(
    (el) => !el.closest('.outside-notes') && !el.querySelector('p, li') && !el.closest('.outside-head'),
  );
  for (const el of statements) {
    el.classList.remove('uncited');
    const cites = [...el.querySelectorAll<HTMLElement>('.cite')];
    const text = textWithTex(el);
    if (!cites.length) {
      if (needsCitation(text)) {
        el.classList.add('uncited');
        report.uncited++;
      }
      continue;
    }
    report.cited++;
    for (const c of cites) {
      const excerpt = excerptFor(Number(c.dataset.cite));
      const weak = excerpt === undefined || supportScore(text, excerpt) < WEAK_BELOW;
      c.classList.toggle('is-weak', weak);
      if (weak) {
        report.weak++;
        c.title = excerpt === undefined ? 'There is no excerpt with this number' : 'This sentence doesn’t closely match the cited note — check it';
      }
    }
  }
  return report;
}
