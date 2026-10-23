import type { Editor } from '@tiptap/core';

/**
 * A tiny typed event bus so node views (rendered by ProseMirror, outside the
 * React tree of the note) can ask the note editor / assistant to do things.
 */
export interface EditorEvents {
  'ink:transcribe': { editor: Editor; blockId: string };
  'ink:convert': { editor: Editor; blockId: string; to: 'text' | 'math' };
  /** Open the inline ink pad, optionally editing an existing sketch at `pos`. */
  'inlineInk:open': { editor: Editor; pos?: number };
  'inlineInk:convert': { editor: Editor; pos: number };
  /** "Ask about this…" on a handwriting area or an equation: the Ask composer opens under it. */
  'block:ask': { editor: Editor; blockId: string };
}

type Handler<T> = (payload: T) => void;

class Bus {
  private map = new Map<string, Set<Handler<unknown>>>();
  on<K extends keyof EditorEvents>(type: K, fn: Handler<EditorEvents[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }
  emit<K extends keyof EditorEvents>(type: K, payload: EditorEvents[K]) {
    this.map.get(type)?.forEach((fn) => fn(payload));
  }
}

export const editorBus = new Bus();
