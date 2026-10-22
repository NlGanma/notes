import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOMSerializer, type Schema } from '@tiptap/pm/model';
import { uid } from '../../lib/util';

/** Top-level block types that get a stable id and can carry ink annotations. */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
  'mathBlock',
  'inkBlock',
  'callout',
];

export const blockIdsKey = new PluginKey('blockIds');

function parseInk(el: HTMLElement) {
  const raw = el.getAttribute('data-ink');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Adds `id` and `ink` attributes to every block type and keeps ids unique.
 * `keepOnSplit: false` means pressing Enter in an annotated paragraph keeps the
 * strokes on the original block rather than duplicating them.
 */
export const BlockAttrs = Extension.create({
  name: 'blockAttrs',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          id: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-id'),
            renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
          },
          ink: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => parseInk(el),
            // Not rendered into the live DOM (it can be large); the clipboard
            // serializer below adds it so copy/paste keeps handwriting.
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdsKey,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const seen = new Set<string>();
          let tr = null as ReturnType<typeof state.tr.setNodeAttribute> | null;
          state.doc.forEach((node, offset) => {
            if (!('id' in node.attrs)) return;
            const id = node.attrs.id as string | null;
            if (!id || seen.has(id)) {
              const fresh = uid('b');
              tr = (tr ?? state.tr).setNodeAttribute(offset, 'id', fresh);
              seen.add(fresh);
            } else {
              seen.add(id);
            }
          });
          if (tr) {
            (tr as typeof state.tr).setMeta('addToHistory', false);
            return tr;
          }
          return null;
        },
      }),
    ];
  },
});

/** Clipboard serializer that embeds ink so copied handwriting survives paste. */
export function createClipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const nodes: typeof base.nodes = {};
  for (const [name, toDOM] of Object.entries(base.nodes)) {
    nodes[name] = (node) => {
      const spec = toDOM(node);
      const ink = node.attrs.ink;
      if (!ink || !Array.isArray(ink) || !ink.length) return spec;
      const json = JSON.stringify(ink);
      if (Array.isArray(spec)) {
        const [tag, maybeAttrs, ...rest] = spec as unknown as [string, unknown, ...unknown[]];
        if (maybeAttrs && typeof maybeAttrs === 'object' && !Array.isArray(maybeAttrs) && !(maybeAttrs instanceof Node)) {
          return [tag, { ...(maybeAttrs as object), 'data-ink': json }, ...rest] as unknown as typeof spec;
        }
        return [tag, { 'data-ink': json }, ...(maybeAttrs === undefined ? [] : [maybeAttrs]), ...rest] as unknown as typeof spec;
      }
      if (spec && typeof spec === 'object' && 'dom' in spec && spec.dom instanceof HTMLElement) {
        spec.dom.setAttribute('data-ink', json);
      }
      return spec;
    };
  }
  return new DOMSerializer(nodes, base.marks);
}

/** Ensures every top-level block in a JSON document has an id. */
export function normalizeDocJSON<T extends { type?: string; content?: { attrs?: Record<string, unknown> }[] }>(doc: T): T {
  if (!doc || !Array.isArray(doc.content)) return doc;
  const seen = new Set<string>();
  for (const block of doc.content) {
    block.attrs = block.attrs ?? {};
    let id = block.attrs.id as string | undefined;
    if (!id || seen.has(id)) {
      id = uid('b');
      block.attrs.id = id;
    }
    seen.add(id);
  }
  return doc;
}
