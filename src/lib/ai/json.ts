/**
 * LaTeX written into JSON strings by a model usually has single backslashes,
 * which JSON reads as escapes: "\\frac" becomes a form feed + "rac", "\\theta" a
 * tab + "heta". Puts the backslash back when a control character is followed
 * by the rest of a LaTeX command.
 */
const LATEX_TAILS: Record<string, RegExp> = {
  '\f': /^(?:rac|orall|lat)(?![a-z])/,
  '\t': /^(?:heta|imes|ext|an|au|ilde|riangle|frac|op)(?![a-z])/,
  '\n': /^(?:abla|eq|ot|ewline|eg|ewcommand)(?![a-z])/,
  '\b': /^(?:eta|ar|inom|oxed|egin|ig|f)(?![a-z])/,
  '\r': /^(?:ho|ight|ightarrow|angle|m)(?![a-z])/,
};
export function fixLatexEscapes(s: string): string {
  return s.replace(/[\f\t\n\b\r]/g, (c, i: number) => (LATEX_TAILS[c]?.test(s.slice(i + 1)) ? `\\${{ '\f': 'f', '\t': 't', '\n': 'n', '\b': 'b', '\r': 'r' }[c]}` : c));
}

function fixStrings<T>(v: T): T {
  if (typeof v === 'string') return fixLatexEscapes(v) as T;
  if (Array.isArray(v)) return v.map(fixStrings) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixStrings(x)])) as T;
  return v;
}

/** Extracts the first JSON object/array from a model reply (tolerates code fences and chatter). */
export function parseJSONLoose<T = unknown>(text: string): T | null {
  const v = parseRaw<T>(text);
  return v === null ? null : fixStrings(v);
}

function parseRaw<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through */
  }
  const starts = ['{', '['];
  for (const open of starts) {
    const close = open === '{' ? '}' : ']';
    const i = cleaned.indexOf(open);
    const j = cleaned.lastIndexOf(close);
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(cleaned.slice(i, j + 1)) as T;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
