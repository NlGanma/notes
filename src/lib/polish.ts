import type { Editor, JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import type { NoteDoc } from './vault/types';
import type { InkTranscript, Stroke } from './ink/types';
import { INK_COLORS } from './ink/brushes';
import { strokeBounds } from './ink/geometry';
import { lineHeightFor } from '../editor/registry';
import { docToText } from './ai/context';
import { markdownToEditorHTML } from './ai/markdown';
import { rearrangeCheck } from './ai/verify';
import { complete, transcribeStrokes } from './ai/actions';
import { BULLETS_PROMPT, SUMMARY_PROMPT } from './ai/prompts';
import { fittedHeight, setTranscript } from '../editor/ink/ops';
import { uid, wordCount } from './util';
import { useVault } from '../state/vault';
import { homeworkFolderFor, suggestClass } from './classes';

/**
 * "Polish": suggestions that keep notes tidy and consistent as you go.
 * Quick fixes run instantly; AI suggestions use the local model.
 */

export interface Suggestion {
  id: string;
  icon: 'space' | 'lines' | 'list' | 'colors' | 'read' | 'math' | 'bullets' | 'summary' | 'headings' | 'class';
  title: string;
  detail: string;
  action: string;
  ai?: 'chat' | 'vision';
  apply(editor: Editor, note: NoteDoc): Promise<void> | void;
}

const LIST_RE = /^\s*([-•*–]|\d+[.)])\s+/;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function colorDist(a: string, b: string) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function nearestPaletteColor(c: string): string {
  let best = c;
  let d = Infinity;
  for (const s of INK_COLORS) {
    const k = colorDist(c, s.value);
    if (k < d) {
      d = k;
      best = s.value;
    }
  }
  return best;
}

function textOf(n: JSONContent): string {
  if (n.type === 'text') return n.text ?? '';
  return (n.content ?? []).map(textOf).join('');
}

function htmlToNodes(editor: Editor, html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const frag = PMDOMParser.fromSchema(editor.schema).parse(div);
  const out: import('@tiptap/pm/model').Node[] = [];
  frag.forEach((n) => out.push(n));
  return out;
}

function blockPos(editor: Editor, id: string): { pos: number; size: number } | null {
  let r: { pos: number; size: number } | null = null;
  editor.state.doc.forEach((n, pos) => {
    if (!r && n.attrs.id === id) r = { pos, size: n.nodeSize };
  });
  return r;
}

export function analyzeNote(note: NoteDoc, opts: { line: number; ai: boolean; vision: boolean }): Suggestion[] {
  const out: Suggestion[] = [];
  const blocks = note.content.content ?? [];
  const text = docToText(note.content);
  const words = wordCount(text);

  // File unfiled notes in the class they belong to.
  {
    const { notes, folders, folderMeta } = useVault.getState();
    const s = suggestClass(note, notes, folders, folderMeta);
    if (s)
      out.push({
        id: 'class',
        icon: 'class',
        title: `Move to ${s.cls.name}`,
        detail: s.terms.length ? `It matches your ${s.cls.name} notes (${s.terms.join(', ')}).` : `It reads like your ${s.cls.name} notes.`,
        action: 'Move',
        apply(_e, n) {
          useVault.getState().moveNote(n.meta.id, n.meta.homework ? homeworkFolderFor(s.cls.path) : s.cls.path);
        },
      });
  }

  // Empty space in handwriting areas
  const emptyInk: string[] = [];
  const looseInk: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'inkBlock') continue;
    const ink = (b.attrs?.ink as Stroke[] | null) ?? [];
    const h = Number(b.attrs?.height ?? 0);
    if (!ink.length) emptyInk.push(String(b.attrs?.id));
    else {
      let bottom = 0;
      let top = Infinity;
      for (const s of ink) {
        const bb = strokeBounds(s);
        bottom = Math.max(bottom, bb.maxY);
        top = Math.min(top, bb.minY);
      }
      if (h - bottom > opts.line * 2.2 || top > opts.line * 2.2) looseInk.push(String(b.attrs?.id));
    }
  }
  if (emptyInk.length || looseInk.length) {
    out.push({
      id: 'space',
      icon: 'space',
      title: 'Tighten handwriting areas',
      detail: [emptyInk.length && `${emptyInk.length} empty`, looseInk.length && `${looseInk.length} with extra blank lines`].filter(Boolean).join(', '),
      action: 'Tidy',
      apply(editor) {
        const tr = editor.state.tr;
        const line = lineHeightFor(editor);
        const toDelete: { pos: number; size: number }[] = [];
        editor.state.doc.forEach((n, pos) => {
          if (n.type.name !== 'inkBlock') return;
          const ink = (n.attrs.ink as Stroke[] | null) ?? [];
          if (!ink.length) {
            toDelete.push({ pos, size: n.nodeSize });
            return;
          }
          let top = Infinity;
          for (const s of ink) top = Math.min(top, strokeBounds(s).minY);
          const shift = Math.max(0, Math.floor((top - 4) / line) * line);
          const moved = shift ? ink.map((s) => ({ ...s, pts: s.pts.map((v, i) => (i % 3 === 1 ? Math.round((v - shift) * 100) / 100 : v)) })) : ink;
          tr.setNodeAttribute(pos, 'ink', moved);
          tr.setNodeAttribute(pos, 'height', fittedHeight(moved, line) + line);
        });
        for (const d of toDelete.reverse()) tr.delete(tr.mapping.map(d.pos), tr.mapping.map(d.pos + d.size));
        closeHistory(tr);
        editor.view.dispatch(tr);
      },
    });
  }

  // Empty lines
  let emptyRuns = 0;
  let trailing = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const empty = b.type === 'paragraph' && !textOf(b).trim() && !(b.content ?? []).some((c) => c.type !== 'text');
    if (empty && i > 0) {
      const prev = blocks[i - 1];
      if (prev.type === 'paragraph' && !textOf(prev).trim() && !(prev.content ?? []).length) emptyRuns++;
    }
    trailing = empty ? trailing + 1 : 0;
  }
  if (emptyRuns + Math.max(0, trailing - 1) > 0) {
    const n = emptyRuns + Math.max(0, trailing - 1);
    out.push({
      id: 'lines',
      icon: 'lines',
      title: 'Remove stray empty lines',
      detail: `${n} extra blank line${n === 1 ? '' : 's'}`,
      action: 'Remove',
      apply(editor) {
        const tr = editor.state.tr;
        const del: { pos: number; size: number }[] = [];
        let prevEmpty = false;
        editor.state.doc.forEach((node, pos) => {
          const empty = node.type.name === 'paragraph' && node.content.size === 0 && !node.attrs.ink;
          if (empty && prevEmpty) del.push({ pos, size: node.nodeSize });
          prevEmpty = empty;
        });
        const last = editor.state.doc.lastChild;
        if (last && last.type.name === 'paragraph' && last.content.size === 0 && !del.length && editor.state.doc.childCount > 1) {
          const pos = editor.state.doc.content.size - last.nodeSize;
          del.push({ pos, size: last.nodeSize });
        }
        for (const d of del.reverse()) tr.delete(d.pos, d.pos + d.size);
        editor.view.dispatch(tr);
      },
    });
  }

  // Hand-typed lists ("- item" paragraphs, e.g. after pasting)
  const listRuns: string[][] = [];
  let run: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph' && LIST_RE.test(textOf(b))) run.push(String(b.attrs?.id));
    else {
      if (run.length >= 2) listRuns.push(run);
      run = [];
    }
  }
  if (run.length >= 2) listRuns.push(run);
  if (listRuns.length) {
    const total = listRuns.reduce((s, r) => s + r.length, 0);
    out.push({
      id: 'list',
      icon: 'list',
      title: 'Turn typed bullets into real lists',
      detail: `${total} lines start with “-”, “•” or “1.”`,
      action: 'Convert',
      apply(editor) {
        for (const ids of [...listRuns].reverse()) {
          const first = blockPos(editor, ids[0]);
          const last = blockPos(editor, ids[ids.length - 1]);
          if (!first || !last) continue;
          const items: JSONContent[] = [];
          let ordered = true;
          editor.state.doc.nodesBetween(first.pos, last.pos + last.size, (node, pos) => {
            if (pos < first.pos || node.type.name !== 'paragraph') return false;
            const json = node.toJSON() as JSONContent;
            const t = textOf(json);
            const m = LIST_RE.exec(t);
            if (m && !/\d/.test(m[1])) ordered = false;
            const strip = m ? m[0].length : 0;
            const content = json.content ? stripLeading(json.content, strip) : [];
            items.push({ type: 'listItem', content: [{ type: 'paragraph', content }] });
            return false;
          });
          const list = editor.schema.nodeFromJSON({ type: ordered ? 'orderedList' : 'bulletList', attrs: { id: uid('b') }, content: items });
          editor.view.dispatch(editor.state.tr.replaceWith(first.pos, last.pos + last.size, list));
        }
      },
    });
  }

  // Heading levels that skip (H1 → H3)
  let lastLevel = 0;
  let skips = 0;
  for (const b of blocks) {
    if (b.type !== 'heading') continue;
    const l = Number(b.attrs?.level ?? 1);
    if (lastLevel && l > lastLevel + 1) skips++;
    lastLevel = l;
  }
  if (skips) {
    out.push({
      id: 'headings',
      icon: 'headings',
      title: 'Even out heading levels',
      detail: `${skips} heading${skips === 1 ? ' skips' : 's skip'} a level`,
      action: 'Fix',
      apply(editor) {
        const tr = editor.state.tr;
        let prev = 0;
        editor.state.doc.forEach((n, pos) => {
          if (n.type.name !== 'heading') return;
          let l = n.attrs.level as number;
          if (prev && l > prev + 1) {
            l = prev + 1;
            tr.setNodeAttribute(pos, 'level', l);
          }
          prev = l;
        });
        editor.view.dispatch(tr);
      },
    });
  }

  // Ink colours scattered across many similar shades
  const colorCounts = new Map<string, number>();
  for (const b of blocks)
    for (const s of ((b.attrs?.ink as Stroke[] | null) ?? []) as Stroke[])
      if (s.brush !== 'highlighter' && s.color.startsWith('#')) colorCounts.set(s.color, (colorCounts.get(s.color) ?? 0) + 1);
  const offPalette = [...colorCounts.keys()].filter((c) => !INK_COLORS.some((p) => p.value === c));
  if (colorCounts.size > 4 || offPalette.length >= 2) {
    out.push({
      id: 'colors',
      icon: 'colors',
      title: 'Harmonize ink colors',
      detail: `${colorCounts.size} different ink colors`,
      action: 'Harmonize',
      apply(editor) {
        const tr = editor.state.tr;
        editor.state.doc.forEach((n, pos) => {
          const ink = (n.attrs.ink as Stroke[] | null) ?? [];
          if (!ink.length) return;
          tr.setNodeAttribute(
            pos,
            'ink',
            ink.map((s) => (s.brush === 'highlighter' || !s.color.startsWith('#') ? s : { ...s, color: nearestPaletteColor(s.color) })),
          );
        });
        closeHistory(tr);
        editor.view.dispatch(tr);
      },
    });
  }

  // Handwriting not read yet
  const unread = blocks.filter((b) => b.type === 'inkBlock' && ((b.attrs?.ink as unknown[] | null) ?? []).length && !b.attrs?.transcript);
  if (unread.length && opts.vision) {
    out.push({
      id: 'read',
      icon: 'read',
      title: 'Make handwriting searchable',
      detail: `${unread.length} handwriting area${unread.length === 1 ? '' : 's'} not read yet`,
      action: 'Read',
      ai: 'vision',
      async apply(editor) {
        for (const b of unread) {
          const t = await transcribeStrokes((b.attrs?.ink as Stroke[]) ?? []);
          if (t) setTranscript(editor, String(b.attrs?.id), t);
        }
      },
    });
  }

  // Handwritten math that could be typeset
  const mathInk = blocks.filter((b) => b.type === 'inkBlock' && (b.attrs?.transcript as InkTranscript | null)?.latex);
  if (mathInk.length) {
    out.push({
      id: 'math',
      icon: 'math',
      title: 'Typeset handwritten math',
      detail: `${mathInk.length} handwritten equation${mathInk.length === 1 ? '' : 's'}`,
      action: 'Typeset',
      apply(editor) {
        for (const b of [...mathInk].reverse()) {
          const at = blockPos(editor, String(b.attrs?.id));
          if (!at) continue;
          const latex = (b.attrs?.transcript as InkTranscript).latex!;
          const exists = editor.state.doc.resolve(at.pos + at.size).nodeAfter;
          if (exists?.type.name === 'mathBlock' && exists.attrs.latex === latex) continue;
          editor.view.dispatch(
            editor.state.tr.insert(
              at.pos + at.size,
              editor.schema.nodes.mathBlock.create({ latex: latex.includes('\\\\') ? `\\begin{aligned}${latex}\\end{aligned}` : latex }),
            ),
          );
        }
      },
    });
  }

  // AI: long paragraph → bullets
  const longPara = blocks.find((b) => b.type === 'paragraph' && wordCount(textOf(b)) > 110);
  if (longPara && opts.ai) {
    out.push({
      id: 'bullets',
      icon: 'bullets',
      title: 'Break up a wall of text',
      detail: `“${textOf(longPara).slice(0, 60)}…”`,
      action: 'Rewrite',
      ai: 'chat',
      async apply(editor) {
        const at = blockPos(editor, String(longPara.attrs?.id));
        if (!at) return;
        const passage = docToText({ type: 'doc', content: [longPara] });
        const md = (await complete([{ role: 'user', content: BULLETS_PROMPT(passage) }], { label: 'Polish · bullets' })).text;
        // The bullets replace the student's own words, so they may only rearrange them: anything new would
        // become "notes" that later answers cite.
        const added = rearrangeCheck(passage, md);
        if (added.length) throw new Error(`The rewrite added things your paragraph doesn’t say (${added.slice(0, 3).map((a) => `“${a}”`).join(', ')}), so your paragraph was left as it is.`);
        const nodes = htmlToNodes(editor, markdownToEditorHTML(md));
        if (nodes.length) editor.view.dispatch(editor.state.tr.replaceWith(at.pos, at.pos + at.size, nodes));
      },
    });
  }

  // AI: summary at the top
  const hasSummary = blocks.slice(0, 3).some((b) => b.type === 'callout' && b.attrs?.variant === 'ai');
  if (words > 220 && !hasSummary && opts.ai) {
    out.push({
      id: 'summary',
      icon: 'summary',
      title: 'Add a summary at the top',
      detail: '',
      action: 'Write',
      ai: 'chat',
      async apply(editor) {
        const md = (await complete([{ role: 'user', content: SUMMARY_PROMPT(text.slice(0, 9000)) }], { label: 'Polish · summary' })).text;
        const nodes = htmlToNodes(editor, markdownToEditorHTML(`**Summary.** ${md.trim()}`));
        const callout = editor.schema.nodes.callout.create({ variant: 'ai' }, nodes.length ? nodes : [editor.schema.nodes.paragraph.create()]);
        editor.view.dispatch(editor.state.tr.insert(0, callout));
      },
    });
  }

  return out;
}

function stripLeading(content: JSONContent[], chars: number): JSONContent[] {
  const out: JSONContent[] = [];
  let left = chars;
  for (const n of content) {
    if (left > 0 && n.type === 'text') {
      const t = n.text ?? '';
      if (t.length <= left) {
        left -= t.length;
        continue;
      }
      out.push({ ...n, text: t.slice(left) });
      left = 0;
    } else out.push(n);
  }
  return out;
}
