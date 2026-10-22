/** Extracts the first JSON object/array from a model reply (tolerates code fences and chatter). */
export function parseJSONLoose<T = unknown>(text: string): T | null {
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
