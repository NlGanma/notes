import type { JSONContent } from '@tiptap/core';
import { escapeHtml } from '../util';
import { isSafeColor, safeColor } from '../vault/sanitize';
import { renderMath, renderMathML } from '../katex';
import { strokesToSvgMarkup } from '../ink/render';
import type { InlineInkAttrs, Stroke } from '../ink/types';
import { inlineInkBox } from '../../editor/extensions/inkInline';

/**
 * Static HTML for a note (thumbnails, PDF and HTML export). Each top-level
 * block is wrapped in `.blk` with its own ink layer, so handwriting stays
 * attached to its block even when a printed page breaks between blocks.
 */

export interface HtmlOptions {
  /** Use MathML only (self-contained, no fonts) — for exported HTML files. */
  mathml?: boolean;
  /** Stop after this many top-level blocks (thumbnails). */
  maxBlocks?: number;
  /** Baseline-grid padding per top-level block, measured by the live editor. */
  pads?: number[];
}

function attr(s: unknown) {
  return escapeHtml(String(s ?? ''));
}

function safeUrl(url: string): string {
  return /^(https?:|mailto:|data:image\/)/i.test(url) ? url : '#';
}

function math(latex: string, display: boolean, o: HtmlOptions) {
  return o.mathml ? renderMathML(latex, display) : renderMath(latex, display);
}

function marks(text: string, list: JSONContent['marks']): string {
  let html = escapeHtml(text);
  for (const m of list ?? []) {
    switch (m.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'highlight':
        html = `<mark style="background:${attr(safeColor(m.attrs?.color || '#fff3a3', '#fff3a3'))}">${html}</mark>`;
        break;
      case 'textStyle':
        if (m.attrs?.color && isSafeColor(m.attrs.color)) html = `<span style="color:${attr(m.attrs.color)}">${html}</span>`;
        break;
      case 'link':
        html = `<a href="${attr(safeUrl(String(m.attrs?.href ?? '')))}">${html}</a>`;
        break;
    }
  }
  return html;
}

function inlineInk(a: InlineInkAttrs): string {
  const box = inlineInkBox(a);
  return `<svg class="ink-inline" viewBox="${box.viewBox}" style="width:${box.width};height:${box.height};vertical-align:${box.verticalAlign}">${strokesToSvgMarkup(
    a.strokes,
  )}</svg>`;
}

function inline(nodes: JSONContent[] | undefined, o: HtmlOptions): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return marks(n.text ?? '', n.marks);
      if (n.type === 'mathInline') return `<span class="math-inline">${math(String(n.attrs?.latex ?? ''), false, o)}</span>`;
      if (n.type === 'inkInline') return inlineInk(n.attrs as InlineInkAttrs);
      if (n.type === 'hardBreak') return '<br>';
      return inline(n.content, o);
    })
    .join('');
}

function block(n: JSONContent, o: HtmlOptions): string {
  switch (n.type) {
    case 'paragraph':
      return `<p>${inline(n.content, o) || '<br>'}</p>`;
    case 'heading': {
      const l = Math.min(3, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `<h${l}>${inline(n.content, o)}</h${l}>`;
    }
    case 'bulletList':
      return `<ul>${(n.content ?? []).map((li) => `<li>${children(li, o)}</li>`).join('')}</ul>`;
    case 'orderedList':
      return `<ol start="${Number(n.attrs?.start ?? 1)}">${(n.content ?? []).map((li) => `<li>${children(li, o)}</li>`).join('')}</ol>`;
    case 'taskList':
      return `<ul class="tasks">${(n.content ?? [])
        .map(
          (li) =>
            `<li class="task${li.attrs?.checked ? ' is-done' : ''}"><span class="task-box">${li.attrs?.checked ? '✓' : ''}</span><div>${children(li, o)}</div></li>`,
        )
        .join('')}</ul>`;
    case 'blockquote':
      return `<blockquote>${children(n, o)}</blockquote>`;
    case 'callout':
      return `<div class="callout" data-variant="${attr(n.attrs?.variant ?? 'note')}"><div class="callout-body">${children(n, o)}</div></div>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml((n.content ?? []).map((t) => t.text ?? '').join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'image':
      return `<img src="${attr(safeUrl(String(n.attrs?.src ?? '')))}" alt="${attr(n.attrs?.alt ?? '')}">`;
    case 'mathBlock':
      return `<div class="math-display">${math(String(n.attrs?.latex ?? ''), true, o)}</div>`;
    case 'inkBlock':
      return `<div class="ink-area" style="height:${Number(n.attrs?.height ?? 64)}px"></div>`;
    default:
      return children(n, o);
  }
}

function children(n: JSONContent, o: HtmlOptions): string {
  return (n.content ?? []).map((c) => block(c, o)).join('');
}

export function docToHTML(doc: JSONContent | undefined, o: HtmlOptions = {}): string {
  const blocks = (doc?.content ?? []).slice(0, o.maxBlocks ?? Infinity);
  return blocks
    .map((b, i) => {
      const ink = (b.attrs?.ink as Stroke[] | null) ?? [];
      // Ink is anchored to the block's border box; headings sit below their top margin.
      const level = Number(b.attrs?.level ?? 1);
      const inkTop = b.type === 'heading' && i > 0 ? (level === 3 ? 'calc(var(--line) * 0.5)' : 'var(--line)') : '0px';
      const svg = ink.length ? `<svg class="blk-ink" width="1" height="1" aria-hidden="true" style="top:${inkTop}">${strokesToSvgMarkup(ink)}</svg>` : '';
      const pad = o.pads?.[i];
      const style = pad && pad > 0.25 ? ` style="padding-bottom:${Math.round(pad * 100) / 100}px"` : '';
      return `<div class="blk blk-${attr(b.type)}"${style}>${block(b, o)}${svg}</div>`;
    })
    .join('\n');
}
