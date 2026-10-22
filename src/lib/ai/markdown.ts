import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { renderMath } from '../katex';

/**
 * Markdown for model output: math via KaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`),
 * citations `[1]` as clickable chips, raw HTML disabled.
 */

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  let open = '';
  let close = '';
  if (src.startsWith('$$', start)) {
    open = '$$';
    close = '$$';
  } else if (src[start] === '$') {
    open = '$';
    close = '$';
  } else if (src.startsWith('\\(', start)) {
    open = '\\(';
    close = '\\)';
  } else if (src.startsWith('\\[', start)) {
    open = '\\[';
    close = '\\]';
  } else return false;

  const contentStart = start + open.length;
  if (open === '$') {
    const next = src[contentStart];
    if (!next || /\s/.test(next) || /\d/.test(src[start - 1] ?? '')) return false;
  }
  let end = contentStart;
  for (;;) {
    end = src.indexOf(close, end);
    if (end < 0) return false;
    if (src[end - 1] === '\\' && open === '$') {
      end++;
      continue;
    }
    break;
  }
  const content = src.slice(contentStart, end);
  if (!content.trim()) return false;
  if (open === '$' && /\s/.test(content[content.length - 1])) return false;
  if (open === '$' && /^\d/.test(src[end + 1] ?? '')) return false; // "$5 … $10"
  if (!silent) {
    const token = state.push(open === '$$' || open === '\\[' ? 'math_display_inline' : 'math_inline', 'math', 0);
    token.content = content;
  }
  state.pos = end + close.length;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const first = state.src.slice(start, max).trim();
  let close = '';
  if (first.startsWith('$$')) close = '$$';
  else if (first.startsWith('\\[')) close = '\\]';
  else return false;
  if (silent) return true;
  let content = first.slice(2);
  let line = startLine;
  let found = false;
  if (content.trimEnd().endsWith(close) && content.trim().length >= close.length) {
    content = content.trimEnd().slice(0, -close.length);
    found = true;
  }
  while (!found && ++line < endLine) {
    const s = state.bMarks[line] + state.tShift[line];
    const text = state.src.slice(s, state.eMarks[line]);
    const idx = text.indexOf(close);
    if (idx >= 0) {
      content += '\n' + text.slice(0, idx);
      found = true;
      break;
    }
    content += '\n' + text;
  }
  if (!found) return false;
  state.line = line + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, state.line];
  return true;
}

const CITE_RE = /^\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\](?!\()/;

/** Expands "1, 3" / "2–4" into the cited numbers ([NaN] for anything that isn't a citation list). */
export function citedNumbers(spec: string): number[] {
  const nums: number[] = [];
  for (const part of spec.split(/\s*,\s*/)) {
    const range = part.split(/\s*[–-]\s*/).map(Number);
    if (range.length === 2) {
      // A citation range is short and ascending ("2–4"); "[1-20]" or "[5-2]" is not one.
      if (!(range[1] >= range[0] && range[1] - range[0] < 10)) return [NaN];
      for (let n = range[0]; n <= range[1]; n++) nums.push(n);
    } else nums.push(Number(part));
  }
  return nums;
}

/** Words that make "[1, 2]" an interval, not a citation: "on [1, 2]", "x ∈ [0, 5]". */
const INTERVAL_BEFORE = /(?:\b(?:on|in|over|within|across|from|between|interval|intervals|domain|range|of)|[∈=⊂⊆])\s*$/i;

/**
 * Whether "[…]" at `pos` is a citation: every number must be a real excerpt
 * number (1…maxCite), and a two-number list right after "on", "in", "∈"…
 * is read as an interval.
 */
export function isCitation(src: string, pos: number, spec: string, maxCite?: number): boolean {
  const nums = citedNumbers(spec);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || (maxCite !== undefined && n > maxCite))) return false;
  if (/[,–-]/.test(spec) && INTERVAL_BEFORE.test(src.slice(Math.max(0, pos - 24), pos))) return false;
  return true;
}

/** "[2]" or "[1, 3]" as a citation chip (see isCitation). */
function citations(state: StateInline, silent: boolean): boolean {
  const m = CITE_RE.exec(state.src.slice(state.pos));
  if (!m) return false;
  const max = (state.env as { maxCite?: number } | undefined)?.maxCite;
  if (!isCitation(state.src, state.pos, m[1], max)) return false;
  if (!silent) {
    // A chip right after a word wraps with that word: the space moves into a no-wrap run
    // (a no-break space alone isn't enough; browsers still wrap before an inline-block).
    const glued = /[\p{L}\p{N}][^\s\p{L}\p{N}]*[ \t]+$/u.test(state.pending);
    if (glued) state.pending = state.pending.replace(/[ \t]+$/, '');
    const token = state.push('citation', 'cite', 0);
    token.content = m[1];
    token.info = glued ? 'glued' : '';
  }
  state.pos += m[0].length;
  return true;
}

/**
 * Drops citation markers (for text inserted into a note) — exactly the ones
 * the chat showed as chips. Runs after math, so nothing inside $…$ is touched.
 */
function stripCitations(state: StateInline, silent: boolean): boolean {
  const m = CITE_RE.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!isCitation(state.src, state.pos, m[1], (state.env as { maxCite?: number } | undefined)?.maxCite)) return false;
  if (!silent) state.pending = state.pending.replace(/[ \t]+$/, '');
  state.pos += m[0].length;
  return true;
}

const OUTSIDE_OPEN = /^\s*:{3,}\s*(?:outside|general(?:[- ]knowledge)?|own(?:[- ]knowledge)?|not[- ]from[- ](?:your[- ]|the[- ])?notes)\b[^\n]*$/i;

/** Labels the app prints itself (the model never writes them). */
export const OWN_HEAD = 'Not from your notes · the AI’s own knowledge — proceed with caution';
export const AUTO_HEAD = 'Not found in your notes · treat this as the AI’s own knowledge — proceed with caution';
export const OWN_TAG = 'not in your notes';

// Inline markers the notes-only check puts around statements in lists, quotes
// and tables (private-use characters: never typed by people or models).
export const OWN_OPEN = '\uE000';
export const OWN_CLOSE = '\uE001';
export const WEAK_OPEN = '\uE002';
export const WEAK_CLOSE = '\uE003';
/** Closes an own-knowledge mark without its "not in your notes" tag: a table row's cells but the last (one tag per row). */
export const OWN_END = '\uE004';
const FENCE_CLOSE = /^\s*:{3,}\s*$/;

/**
 * Text to put inside a box the app draws: a fence line of the model's own
 * (":::", ":::note") would close the box early and leave the rest unlabelled.
 */
export function boxBody(text: string): string {
  return text.replace(/^[ \t]*:{3,}[^\n]*(?:\n|$)/gm, '').trim();
}

/**
 * Tidies the "not from your notes" fences models write: accepts a few
 * spellings, and closes a block that is still open (while streaming, or when
 * the model forgot) so the box shows up immediately.
 */
export function normalizeOutside(src: string): string {
  const lines = src.split('\n');
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (!open && OUTSIDE_OPEN.test(lines[i])) {
      // Boxes Nib made itself (unsupported sentences it moved) keep their flag.
      lines[i] = /^\s*:{3,}\s*outside\s+auto\b/i.test(lines[i]) ? ':::outside auto' : ':::outside';
      open = true;
    } else if (open && FENCE_CLOSE.test(lines[i])) {
      lines[i] = ':::';
      open = false;
    }
  }
  return open ? `${lines.join('\n')}\n:::` : lines.join('\n');
}

/** Block rule for `:::outside … :::` containers. */
function outsideBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
  const head = /^:::outside(?:\s+(auto))?\s*$/.exec(lineText(startLine));
  if (!head) return false;
  if (silent) return true;
  let line = startLine + 1;
  while (line < endLine && !/^:::\s*$/.test(lineText(line))) line++;
  const open = state.push('outside_open', 'div', 1);
  open.block = true;
  open.map = [startLine, line];
  open.info = head[1] ?? '';
  const oldParent = state.parentType;
  const oldMax = state.lineMax;
  state.parentType = 'outside' as never;
  state.lineMax = line;
  state.md.block.tokenize(state, startLine + 1, line);
  state.parentType = oldParent;
  state.lineMax = oldMax;
  const close = state.push('outside_close', 'div', -1);
  close.block = true;
  state.line = Math.min(line + 1, endLine);
  return true;
}

function build(withCitations: boolean) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('fence', 'outside', outsideBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.outside_open = (tokens, idx) =>
    tokens[idx].info === 'auto'
      ? `<div class="outside-notes is-auto"><div class="outside-head"><span class="outside-icon" aria-hidden="true"></span>${AUTO_HEAD}</div>\n`
      : `<div class="outside-notes"><div class="outside-head"><span class="outside-icon" aria-hidden="true"></span>${OWN_HEAD}</div>\n`;
  md.renderer.rules.outside_close = () => '</div>\n';
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
  md.renderer.rules.math_display_inline = (tokens, idx) => `<span class="md-display">${renderMath(tokens[idx].content, true)}</span>`;
  md.renderer.rules.math_block = (tokens, idx) => `<div class="md-display">${renderMath(tokens[idx].content, true)}</div>\n`;
  if (withCitations) {
    md.inline.ruler.before('link', 'citation', citations);
    md.renderer.rules.citation = (tokens, idx) => {
      const chips = citedNumbers(tokens[idx].content)
        .map((n) => `<button class="cite" data-cite="${n}" type="button">${n}</button>`)
        .join('');
      return tokens[idx].info ? `<span class="cite-run">&nbsp;${chips}</span>` : chips;
    };
  }
  const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noreferrer');
    return defaultLink(tokens, idx, options, env, self);
  };
  return md;
}

const plain = build(false);
const cited = build(true);

/** The excerpt numbers an answer actually cites, exactly as the chips render (never from math or intervals). */
export function citedInAnswer(src: string, maxCite?: number): Set<number> {
  const out = new Set<number>();
  const walk = (tokens: { type: string; content: string; children: unknown[] | null }[]) => {
    for (const t of tokens) {
      if (t.type === 'citation') citedNumbers(t.content).forEach((n) => out.add(n));
      if (t.children) walk(t.children as never);
    }
  };
  walk(cited.parse(normalizeOutside(src), { maxCite }) as never);
  return out;
}

/**
 * A reply still being written, or cut off, can end inside a formula ("…and
 * $\lim g = \lim"), which shows as raw TeX until it closes: the formula is left
 * out until then. Only the last paragraph is looked at; what Nib wrote after
 * it stays: the box it closes, citations it added, the end of a mark.
 */
export function withoutOpenMath(md: string): string {
  const fence = /\n:::[ \t]*$/.exec(md)?.[0] ?? '';
  const body = md.slice(0, md.length - fence.length);
  let start = 0;
  for (const m of body.matchAll(/\n[ \t]*\n/g)) start = m.index! + m[0].length;
  const at = openMathAt(body.slice(start));
  if (at < 0) return md;
  const cut = body.slice(start + at);
  const marks = cut.match(MARKS)?.join('') ?? '';
  const cites = /(?:\s*\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\](?!\())+\s*$/.exec(cut.replace(MARKS, ''))?.[0].trim();
  return `${body.slice(0, start + at).trimEnd()}${cites ? ` ${cites}` : ''}${marks}${fence}`;
}

/** Any of the inline markers. */
const MARKS = new RegExp(`[${OWN_OPEN}-${OWN_END}]`, 'g');

/** Where a formula opens without closing in `s` (-1 if none). A lone "$5" is a price, not a formula. */
function openMathAt(s: string): number {
  let at = -1;
  let close = '';
  for (let i = 0; i < s.length; i++) {
    if (at >= 0) {
      if (s.startsWith(close, i) && !(close === '$' && s[i - 1] === '\\')) {
        i += close.length - 1;
        at = -1;
      }
      continue;
    }
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '(' || s[i + 1] === '[') {
        at = i;
        close = s[i + 1] === '(' ? '\\)' : '\\]';
      }
      i++;
    } else if (c === '`') {
      // Code spans can hold a "$".
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end < 0) break;
      i = end + run.length - 1;
    } else if (c === '$') {
      const display = s[i + 1] === '$';
      // As in mathInline: a "$" after a digit or before a space opens nothing.
      if (!display && (/\d/.test(s[i - 1] ?? '') || /\s/.test(s[i + 1] ?? ' '))) continue;
      at = i;
      close = display ? '$$' : '$';
      i += close.length - 1;
    }
  }
  if (at < 0 || close !== '$') return at;
  const rest = s.slice(at + 1);
  return /^[\p{L}\\({]/u.test(rest) || /[\\^_{}=]/.test(rest) ? at : -1;
}

/**
 * Renders model output. With `citations`, "[n]" becomes a chip; pass
 * `maxCite` (the number of excerpts) so only real excerpt numbers do.
 */
export function renderMarkdown(src: string, opts: { citations?: boolean; maxCite?: number } = {}): string {
  return inlineMarkers((opts.citations ? cited : plain).render(normalizeOutside(src), { maxCite: opts.maxCite }));
}

/** Statements the notes-only check marked inside lists, quotes and tables. */
function inlineMarkers(html: string): string {
  if (!/[\uE000-\uE004]/.test(html)) return html;
  return html
    .replace(/\uE000/g, `<span class="own-inline" title="${OWN_HEAD}">`)
    .replace(/\uE001/g, `</span><span class="own-tag" title="${OWN_HEAD}">${OWN_TAG}</span>`)
    .replace(/\uE004/g, '</span>')
    .replace(/\uE002/g, '<span class="weak-claim" title="This doesn’t closely match the cited note — check it">')
    .replace(/\uE003/g, '</span>');
}

/**
 * Converts markdown into HTML the editor can parse (math → math nodes).
 * `stripCitations` removes "[n]" markers from assistant answers; it is off for
 * the student's own text (imports, handwriting), where "[0, 1]" is an interval.
 */
export function markdownToEditorHTML(src: string, opts: { stripCitations?: boolean; maxCite?: number } = {}): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  md.renderer.rules.math_inline = (t, i) => `<span data-type="math-inline" data-latex="${esc(t[i].content)}"></span>`;
  md.renderer.rules.math_display_inline = (t, i) => `<span data-type="math-inline" data-latex="${esc(t[i].content)}"></span>`;
  md.renderer.rules.math_block = (t, i) => `<div data-type="math-block" data-latex="${esc(t[i].content)}"></div>`;
  // General-knowledge passages stay visibly marked when inserted into a note.
  md.block.ruler.before('fence', 'outside', outsideBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.outside_open = () => '<div data-type="callout" data-variant="outside"><div class="callout-body">\n';
  md.renderer.rules.outside_close = () => '</div></div>\n';
  // The editor has no tables: each row becomes a bullet, its cells joined by " · " (the header row in bold).
  const blank = (t: Token[], i: number) => !t[i]?.content.trim();
  const cell = (t: Token[], i: number) => {
    if (blank(t, i + 1)) return '';
    for (let j = i - 1; j >= 0 && t[j].type !== 'tr_open'; j--) if (t[j].type === 'inline' && !blank(t, j)) return ' · ';
    return '';
  };
  md.renderer.rules.table_open = () => '<ul>\n';
  md.renderer.rules.table_close = () => '</ul>\n';
  for (const rule of ['thead_open', 'thead_close', 'tbody_open', 'tbody_close', 'td_close']) md.renderer.rules[rule] = () => '';
  md.renderer.rules.tr_open = () => '<li><p>';
  md.renderer.rules.tr_close = () => '</p></li>\n';
  md.renderer.rules.th_open = (t, i) => (blank(t, i + 1) ? '' : `${cell(t, i)}<strong>`);
  md.renderer.rules.th_close = (t, i) => (blank(t, i - 1) ? '' : '</strong>');
  md.renderer.rules.td_open = (t, i) => cell(t, i);
  if (opts.stripCitations) md.inline.ruler.before('link', 'citation_strip', stripCitations);
  // Inline own-knowledge marks stay visible in the note as words (once per table row).
  return md
    .render(normalizeOutside(src), { maxCite: opts.maxCite })
    .replace(/[\uE000\uE004]/g, '')
    .replace(/\uE001/g, ' <em>(not from your notes — the AI’s own knowledge)</em>')
    .replace(/[\uE002\uE003]/g, '');
}
