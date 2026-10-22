/**
 * Finding a model's quote in the student's notes. Small models paraphrase
 * when asked to copy, so they are only asked for a short anchor (the first
 * words of a line) and the app cuts the note's own line itself: whatever is
 * stored or shown as "your notes say" is always the note's text, never the
 * model's.
 */

/** Lowercase, accents folded, markdown and punctuation styles unified, whitespace collapsed. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\*\*|__|==|`/g, '')
    .replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$)/g, '$1')
    .replace(/[“”«»„"]/g, '"')
    .replace(/[‘’`´]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const words = (s: string) => normalizeForQuote(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Lines and sentences of a passage (the units a quote can be cut to). */
export function unitsOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const l = line.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '').replace(/^\s*>\s*(?:\*\*[^*]+:\*\*\s*)?/, '').replace(/^#{1,6}\s+/, '').trim();
    if (!l) continue;
    out.push(l);
    const parts = l.split(/(?<=[.!?])\s+(?=[\p{Lu}¿¡(])/u);
    if (parts.length > 1) out.push(...parts.map((p) => p.trim()).filter(Boolean));
  }
  return out;
}

/** Whether `part` appears in `text` once both are normalised. */
export function isSpanOf(part: string, text: string): boolean {
  const p = normalizeForQuote(part);
  return !!p && normalizeForQuote(text).includes(p);
}

/**
 * The note's own line that a short anchor ("the first 6–10 words of the
 * line") points at, or null. Accepts the anchor anywhere in a line; otherwise
 * a contiguous run covering ≥80% of the anchor's words (at least 5).
 */
export function expandProof(proof: string, text: string): string | null {
  const p = normalizeForQuote(proof).replace(/[.…]+$/, '');
  if (words(p).length < 3) return null;
  const units = unitsOf(text);
  // Prefer the shortest unit that contains it (a sentence over its whole line).
  const hits = units.filter((u) => normalizeForQuote(u).includes(p)).sort((a, b) => a.length - b.length);
  if (hits.length) return hits[0];
  const pw = words(p);
  let best: { u: string; run: number } | null = null;
  for (const u of units) {
    const uw = words(u);
    // Longest run of consecutive anchor words found consecutively in the unit.
    for (let i = 0; i < pw.length; i++)
      for (let j = 0; j < uw.length; j++) {
        let k = 0;
        while (i + k < pw.length && j + k < uw.length && pw[i + k] === uw[j + k]) k++;
        if (k > (best?.run ?? 0)) best = { u, run: k };
      }
  }
  return best && best.run >= 5 && best.run >= 0.8 * pw.length ? best.u : null;
}

/** A whole quote (not just an anchor) located in a passage: the passage's own words, or null. */
export function findQuote(quote: string, text: string): string | null {
  if (isSpanOf(quote, text)) {
    const q = normalizeForQuote(quote);
    return unitsOf(text).find((u) => normalizeForQuote(u).includes(q)) ?? quote;
  }
  return expandProof(quote, text);
}
