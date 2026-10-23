import type { JSONContent } from '@tiptap/core';
import type { NoteDoc } from './vault/types';

/*
 * The name a note goes by when nobody gave it one. Nothing ever requires a title: an untitled note
 * is named by its first typed line, else what its handwriting says, else its date.
 *
 * UI only (labels, tabs, the window title, the palette, export file names). Never stored in
 * meta.title, never used for vault file paths or for the notes the AI searches: a derived name
 * changing as the first line is typed must not rename files or count words as "in your notes".
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX = 60;

// Built by hand rather than with toLocaleDateString, so a name reads the same on every machine.
const shortDate = (t: number) => {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const dayDate = (t: number) => `${DAYS[new Date(t).getDay()]}, ${shortDate(t)}`;

/** Cuts a line to 60 characters at a word boundary. */
function clip(line: string): string {
  const s = line.replace(/\s+/g, ' ').trim();
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

// LaTeX commands a name shows as their symbol (each entry: the command's name, then the symbol).
const SYMBOLS: Record<string, string> = Object.fromEntries(
  'to→ implies⇒ infty∞ in∈ partial∂ cdot· div÷ times× pm± le≤ leq≤ ge≥ geq≥ ne≠ neq≠ approx≈ alphaα betaβ gammaγ deltaδ DeltaΔ thetaθ lambdaλ muμ piπ sigmaσ omegaω'
    .split(' ')
    .map((e) => [e.slice(0, -1), e.slice(-1)]),
);

// An operator's limits as small figures, when every character has one: "\int_0^1" reads "∫₀¹".
const pairs = (from: string, to: string) => Object.fromEntries([...from].map((c, i) => [c, [...to][i]]));
const SUB = pairs('0123456789+-=()ijknx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ᵢⱼₖₙₓ');
const SUP = pairs('0123456789+-=()ijknx', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱʲᵏⁿˣ');
const small = (s: string, map: Record<string, string>) => {
  const t = s.replace(/\s+/g, '');
  return [...t].every((c) => c in map) ? [...t].map((c) => map[c]).join('') : null;
};
const OPS: Record<string, string> = { sum: 'Σ', int: '∫', prod: 'Π' };
// What follows _ or ^: a {group}, a command, or one character.
const ARG = String.raw`\{[^{}]*\}|\\[a-zA-Z]+|[^\s\\{}]`;
const OPERATOR = new RegExp(String.raw`\\(sum|int|prod|lim|max|min)(?![a-zA-Z])(?:_(${ARG}))?(?:\^(${ARG}))?`, 'g');

/** "x - 3" goes in parentheses before a slash; "1", "2x" or "\pi" don't need them. */
const group = (s: string) => (/^[^\s+\-−*/=,±·×]+$/.test(s.trim()) ? s.trim() : `(${s.trim()})`);

/** A formula as a name can show it: "\lim_{x \to 3} \frac{x^2 - 9}{x - 3}" reads "lim x→3 (x^2 - 9)/(x - 3)". */
function plainMath(latex: string): string {
  let t = latex.replace(/\\(?:left|right)(?![a-zA-Z])|\\[,;:! ]/g, ' ').replace(/\\(?:text|mathrm|operatorname|mathbf)\{([^{}]*)\}/g, '$1');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a: string, b: string) => `${group(a)}/${group(b)}`)
      .replace(/\\sqrt\{([^{}]*)\}/g, (_, a: string) => `√${group(a)}`);
  }
  return t
    .replace(OPERATOR, (_, op: string, lo?: string, hi?: string) => {
      const [a, b] = [lo, hi].map((x) => (x ? plainMath(x.replace(/^\{|\}$/g, '')) : ''));
      if (!OPS[op]) return ` ${op} ${a}${b ? `^${b}` : ''} `;
      const [sa, sb] = [small(a, SUB), small(b, SUP)];
      if (sa !== null && sb !== null) return ` ${OPS[op]}${sa}${sb} `;
      const lim = (x: string) => (x.length > 1 ? `(${x.replace(/\s+/g, '')})` : x);
      // ("_" is set aside here as \uE000: the ones in "v_0" are dropped below, this one stays.)
      return ` ${OPS[op]}${a ? `\uE000${lim(a)}` : ''}${b ? `^${lim(b)}` : ''} `;
    })
    .replace(/_\{([^{}]*)\}/g, '$1')
    .replace(/\^\{([^{}]*)\}/g, (_, e: string) => (e.length > 1 ? `^(${e})` : `^${e}`))
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) => SYMBOLS[name] ?? name)
    .replace(/[{}_]/g, '')
    .replace(/\uE000/g, '_')
    .replace(/\s*([→⇒])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What was read with its LaTeX written out: "$$…$$", "\[…\]", "\(…\)", bare commands, and "$…$" by pandoc's
 * rule (it opens before a non-space and closes after one, never right before a digit), so "$5 and $10" stays money.
 */
function plainLines(text: string): string[] {
  const t = text.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g, (_, a?: string, b?: string, c?: string) =>
    plainMath(a ?? b ?? c ?? ''),
  );
  return t.split('\n').map((line) => {
    const l = line.replace(/\$\$/g, '').replace(/\$(?=[^\s$])([^$]*?[^\s$])\$(?!\d)/g, (_, m: string) => plainMath(m));
    return (/\\[a-zA-Z]/.test(l) ? plainMath(l) : l).trim();
  });
}

/** The first line of what was read, as a name or a toast shows it. */
export function readLine(text: string): string {
  return clip(plainLines(text).find(Boolean) ?? '');
}

function inlineText(nodes: JSONContent[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') out += n.text ?? '';
    else if (n.type === 'hardBreak') out += '\n';
    else if (n.type === 'mathInline') out += plainMath(String(n.attrs?.latex ?? ''));
    else if (n.content) out += inlineText(n.content);
  }
  return out;
}

/** The first non-empty line of typed text, in document order. */
function firstTypedLine(blocks: JSONContent[] | undefined, skip: (line: string) => boolean): string | null {
  for (const b of blocks ?? []) {
    if (b.type === 'paragraph' || b.type === 'heading') {
      for (const line of inlineText(b.content).split('\n')) {
        const t = line.trim();
        if (t && !skip(t)) return t;
      }
    } else if (b.content && b.type !== 'inkBlock' && b.type !== 'codeBlock') {
      const inner = firstTypedLine(b.content, skip);
      if (inner) return inner;
    }
  }
  return null;
}

/** The first line of what Nib read from the handwriting. */
function firstInkLine(blocks: JSONContent[] | undefined): string | null {
  for (const b of blocks ?? []) {
    if (b.type === 'inkBlock') {
      const t = b.attrs?.transcript as { text?: string; description?: string } | null | undefined;
      // (its math written out, so "$\\lim_{x \\to 3}$" never shows up in a tab)
      const line = readLine(t?.text || t?.description || '');
      if (line) return line;
    } else if (b.content) {
      const inner = firstInkLine(b.content);
      if (inner) return inner;
    }
  }
  return null;
}

/** The name an untitled note falls back to when it has nothing written yet: its date (homework: when it's due). */
export function dateTitle(note: NoteDoc): string {
  const hw = note.meta.homework;
  if (hw) return hw.due ? `Homework · due ${dayDate(hw.due)}` : `Homework · ${shortDate(note.meta.created)}`;
  return `Note · ${shortDate(note.meta.created)}`;
}

const memo = new WeakMap<NoteDoc, string>();

/** What to call a note anywhere it is shown. Notes are replaced, never mutated, so one name per object is safe. */
export function displayTitle(note: NoteDoc): string {
  const hit = memo.get(note);
  if (hit !== undefined) return hit;
  const title = note.meta.title.trim();
  // New homework starts with a "My work" heading; that is the page's scaffolding, not its name.
  const skip = note.meta.homework ? (l: string) => l === 'My work' : () => false;
  const name = title || clip(firstTypedLine(note.content.content, skip) ?? '') || firstInkLine(note.content.content) || dateTitle(note);
  memo.set(note, name);
  return name;
}

/** True when the shown name is only the date fallback (the title field then shows it as its placeholder). */
export function isDateTitle(note: NoteDoc): boolean {
  return !note.meta.title.trim() && displayTitle(note) === dateTitle(note);
}
