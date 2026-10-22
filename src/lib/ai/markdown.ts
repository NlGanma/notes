import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
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

function citations(state: StateInline, silent: boolean): boolean {
  const m = /^\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\](?!\()/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const token = state.push('citation', 'cite', 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

function build(withCitations: boolean) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
  md.renderer.rules.math_display_inline = (tokens, idx) => `<span class="md-display">${renderMath(tokens[idx].content, true)}</span>`;
  md.renderer.rules.math_block = (tokens, idx) => `<div class="md-display">${renderMath(tokens[idx].content, true)}</div>\n`;
  if (withCitations) {
    md.inline.ruler.before('link', 'citation', citations);
    md.renderer.rules.citation = (tokens, idx) => {
      const nums: number[] = [];
      for (const part of tokens[idx].content.split(/\s*,\s*/)) {
        const range = part.split(/\s*[–-]\s*/).map(Number);
        if (range.length === 2 && range[1] >= range[0] && range[1] - range[0] < 10) for (let n = range[0]; n <= range[1]; n++) nums.push(n);
        else nums.push(Number(part));
      }
      return nums.map((n) => `<button class="cite" data-cite="${n}" type="button">${n}</button>`).join('');
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

export function renderMarkdown(src: string, opts: { citations?: boolean } = {}): string {
  return (opts.citations ? cited : plain).render(src);
}

/** Converts model markdown into HTML the editor can parse (math → math nodes). */
export function markdownToEditorHTML(src: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  md.renderer.rules.math_inline = (t, i) => `<span data-type="math-inline" data-latex="${esc(t[i].content)}"></span>`;
  md.renderer.rules.math_display_inline = (t, i) => `<span data-type="math-inline" data-latex="${esc(t[i].content)}"></span>`;
  md.renderer.rules.math_block = (t, i) => `<div data-type="math-block" data-latex="${esc(t[i].content)}"></div>`;
  // Strip citation markers from inserted text.
  return md.render(src.replace(/\s?\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, ''));
}
