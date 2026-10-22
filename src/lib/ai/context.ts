import type { JSONContent } from '@tiptap/core';
import type { InkTranscript } from '../ink/types';

/**
 * Turns a note document into compact Markdown-ish text for prompts and for
 * the search index. Handwriting appears as its transcript (read by the local
 * vision model), so the assistant has the whole page in context.
 */

function inline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      let t = n.text ?? '';
      const marks = (n.marks ?? []).map((m) => m.type);
      if (marks.includes('code')) t = '`' + t + '`';
      if (marks.includes('bold')) t = `**${t}**`;
      if (marks.includes('highlight')) t = `==${t}==`;
      out += t;
    } else if (n.type === 'mathInline') out += `$${n.attrs?.latex ?? ''}$`;
    else if (n.type === 'inkInline') out += n.attrs?.transcript ? String(n.attrs.transcript) : '[hand-drawn symbol]';
    else if (n.type === 'hardBreak') out += '\n';
    else if (n.content) out += inline(n.content);
  }
  return out;
}

export function inkTranscriptText(t: InkTranscript | null | undefined): string | null {
  if (!t || (!t.text && !t.latex && !t.description)) return null;
  const parts: string[] = [];
  if (t.text) parts.push(t.text);
  if (t.latex && !t.text?.includes(t.latex)) parts.push(`$$${t.latex}$$`);
  if (t.description) parts.push(`(drawing: ${t.description})`);
  return parts.join(' ');
}

export function blockToText(n: JSONContent, depth = 0): string {
  const pad = '  '.repeat(depth);
  switch (n.type) {
    case 'paragraph':
      return inline(n.content);
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (n.content ?? [])
        .map((item, i) => {
          const marker = n.type === 'orderedList' ? `${i + 1}.` : n.type === 'taskList' ? (item.attrs?.checked ? '- [x]' : '- [ ]') : '-';
          const [first, ...rest] = item.content ?? [];
          const head = `${pad}${marker} ${first ? blockToText(first, depth + 1) : ''}`;
          const tail = rest.map((r) => blockToText(r, depth + 1)).filter(Boolean);
          return [head, ...tail].join('\n');
        })
        .join('\n');
    case 'blockquote':
      return (n.content ?? []).map((c) => '> ' + blockToText(c, depth)).join('\n');
    case 'callout': {
      const v = String(n.attrs?.variant ?? 'note');
      const label = v === 'ai' ? 'AI note' : v[0].toUpperCase() + v.slice(1);
      return `> **${label}:** ` + (n.content ?? []).map((c) => blockToText(c, depth)).join('\n> ');
    }
    case 'codeBlock':
      return '```\n' + inline(n.content) + '\n```';
    case 'mathBlock':
      return `$$${n.attrs?.latex ?? ''}$$`;
    case 'inkBlock': {
      const strokes = (n.attrs?.ink as unknown[] | null) ?? [];
      if (!strokes.length) return '';
      const t = inkTranscriptText(n.attrs?.transcript as InkTranscript | null);
      return t ? `[Handwritten: ${t}]` : '[Handwritten notes — not transcribed yet]';
    }
    case 'image':
      return `[Image${n.attrs?.alt ? `: ${n.attrs.alt}` : ''}]`;
    case 'horizontalRule':
      return '---';
    default:
      return n.content ? n.content.map((c) => blockToText(c, depth)).join('\n') : '';
  }
}

export function docToText(doc: JSONContent | undefined): string {
  if (!doc?.content) return '';
  return doc.content
    .map((b) => blockToText(b))
    .filter((s) => s.trim())
    .join('\n\n');
}

export interface DocBlock {
  id: string;
  type: string;
  text: string;
  /** Heading path above this block, e.g. "Limits › Squeeze theorem". */
  section: string;
}

export function docBlocks(doc: JSONContent | undefined): DocBlock[] {
  const out: DocBlock[] = [];
  const stack: string[] = [];
  for (const b of doc?.content ?? []) {
    if (b.type === 'heading') {
      const level = Number(b.attrs?.level ?? 1);
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = inline(b.content);
    }
    const text = blockToText(b);
    if (!text.trim()) continue;
    out.push({ id: String(b.attrs?.id ?? ''), type: b.type ?? '', text, section: stack.filter(Boolean).join(' › ') });
  }
  return out;
}

/** Rough token estimate (≈ 4 characters per token for English). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

/** Trims text to a token budget, keeping the part around `focus` if given. */
export function fitToBudget(text: string, maxTokens: number, focus?: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.floor(maxTokens * 3.6);
  let center = text.length / 2;
  if (focus) {
    const i = text.indexOf(focus.slice(0, 60));
    if (i >= 0) center = i;
  }
  const start = Math.max(0, Math.min(text.length - maxChars, Math.floor(center - maxChars / 2)));
  return (start > 0 ? '…\n' : '') + text.slice(start, start + maxChars) + (start + maxChars < text.length ? '\n…' : '');
}
