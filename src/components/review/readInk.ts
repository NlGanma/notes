import type { JSONContent } from '@tiptap/core';
import { useVault } from '../../state/vault';
import { editors } from '../../editor/registry';
import { setTranscript } from '../../editor/ink/ops';
import { transcribeStrokes } from '../../lib/ai/actions';
import { inkTranscriptText } from '../../lib/ai/context';
import type { InkTranscript, Stroke } from '../../lib/ink/types';

/** A note's handwriting areas that nothing has read yet: what Review can't ask about. */
export function unreadInk(content: JSONContent | undefined): { id: string; strokes: Stroke[] }[] {
  const out: { id: string; strokes: Stroke[] }[] = [];
  for (const n of content?.content ?? []) {
    if (n.type === 'inkBlock') {
      const strokes = (n.attrs?.ink as Stroke[] | null) ?? [];
      if (strokes.length && !inkTranscriptText(n.attrs?.transcript as InkTranscript | null)) out.push({ id: String(n.attrs?.id), strokes });
    } else if (n.content) out.push(...unreadInk(n));
  }
  return out;
}

function withTranscript(node: JSONContent, id: string, t: InkTranscript): JSONContent {
  if (node.type === 'inkBlock' && node.attrs?.id === id) return { ...node, attrs: { ...node.attrs, transcript: t } };
  return node.content ? { ...node, content: node.content.map((c) => withTranscript(c, id, t)) } : node;
}

/**
 * Reads a note's unread handwriting with the vision model, as a block's ⋯ › Read handwriting does, so Review
 * can ask about it. `onRead` follows along, one area at a time. Returns how many areas were read.
 */
export async function readNoteInk(noteId: string, onRead?: () => void): Promise<number> {
  let read = 0;
  for (const b of unreadInk(useVault.getState().notes[noteId]?.content)) {
    const t = await transcribeStrokes(b.strokes);
    onRead?.();
    if (!t) continue;
    // An open note takes it through its editor, which would otherwise write its own copy back over it.
    const ed = editors.get(noteId);
    if (ed && !ed.isDestroyed) setTranscript(ed, b.id, t);
    else {
      const cur = useVault.getState().notes[noteId];
      if (!cur) break;
      useVault.getState().updateContent(noteId, withTranscript(cur.content, b.id, t));
    }
    read++;
  }
  return read;
}
