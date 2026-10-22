import type { JSONContent } from '@tiptap/core';
import { strokesToSvgMarkup } from '../ink/render';
import { strokeBounds, unionBounds } from '../ink/geometry';
import type { InlineInkAttrs, Stroke } from '../ink/types';
import { utf8ToBase64 } from '../util';

/** Markdown export. Handwriting becomes embedded SVG images so nothing is lost. */

function svgDataUri(strokes: Stroke[], w: number, h: number, minX = 0, minY = 0): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${minX} ${minY} ${w} ${h}">${strokesToSvgMarkup(
    strokes.map((s) => (s.color === 'currentColor' ? { ...s, color: '#1c1c1e' } : s)),
  )}</svg>`;
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

function inline(nodes: JSONContent[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') {
        let t = (n.text ?? '').replace(/([*_`[\]\\])/g, '\\$1');
        for (const m of n.marks ?? []) {
          if (m.type === 'bold') t = `**${t}**`;
          else if (m.type === 'italic') t = `*${t}*`;
          else if (m.type === 'strike') t = `~~${t}~~`;
          else if (m.type === 'code') t = '`' + (n.text ?? '') + '`';
          else if (m.type === 'highlight') t = `==${t}==`;
          else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`;
        }
        return t;
      }
      if (n.type === 'mathInline') return `$${n.attrs?.latex ?? ''}$`;
      if (n.type === 'hardBreak') return '  \n';
      if (n.type === 'inkInline') {
        const a = n.attrs as InlineInkAttrs;
        return `![${a.transcript ?? 'sketch'}](${svgDataUri(a.strokes, a.w + 4, a.h + 4, -2, -2)})`;
      }
      return inline(n.content);
    })
    .join('');
}

function block(n: JSONContent, indent = ''): string {
  switch (n.type) {
    case 'paragraph':
      return indent + inline(n.content);
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (n.content ?? [])
        .map((li, i) => {
          const marker = n.type === 'orderedList' ? `${i + 1}.` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}]` : '-';
          const [first, ...rest] = li.content ?? [];
          const head = `${indent}${marker} ${first ? block(first).trimStart() : ''}`;
          const tail = rest.map((r) => block(r, indent + '   '));
          return [head, ...tail].join('\n');
        })
        .join('\n');
    case 'blockquote':
      return (n.content ?? [])
        .map((c) =>
          block(c)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        )
        .join('\n>\n');
    case 'callout':
      return (
        `> [!${String(n.attrs?.variant ?? 'note').toUpperCase()}]\n` +
        (n.content ?? [])
          .map((c) =>
            block(c)
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n'),
          )
          .join('\n>\n')
      );
    case 'codeBlock':
      return '```' + (n.attrs?.language ?? '') + '\n' + (n.content ?? []).map((t) => t.text ?? '').join('') + '\n```';
    case 'mathBlock':
      return `$$\n${n.attrs?.latex ?? ''}\n$$`;
    case 'horizontalRule':
      return '---';
    case 'image':
      return `![${n.attrs?.alt ?? ''}](${n.attrs?.src ?? ''})`;
    case 'inkBlock': {
      const ink = (n.attrs?.ink as Stroke[] | null) ?? [];
      if (!ink.length) return '';
      const b = unionBounds(ink.map(strokeBounds))!;
      const t = n.attrs?.transcript as { text?: string } | null;
      return `![${t?.text?.replace(/[\]\n]/g, ' ') ?? 'handwriting'}](${svgDataUri(ink, b.maxX - b.minX + 8, b.maxY - b.minY + 8, b.minX - 4, b.minY - 4)})`;
    }
    default:
      return (n.content ?? []).map((c) => block(c, indent)).join('\n\n');
  }
}

export function docToMarkdown(title: string, doc: JSONContent | undefined): string {
  const body = (doc?.content ?? [])
    .map((b) => block(b))
    .filter((s) => s.trim())
    .join('\n\n');
  return `# ${title || 'Untitled'}\n\n${body}\n`;
}
