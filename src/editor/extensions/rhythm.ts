import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Vertical rhythm.
 *
 * Every top-level block is padded so its height is a whole number of ruled
 * lines (`--line`). That keeps typed text, handwriting areas, math and images
 * on one shared baseline grid: ruled paper lines stay aligned with the text no
 * matter what blocks sit above, and handwriting lines up with typing.
 */
export const rhythmKey = new PluginKey<{ pads: number[] }>('rhythm');

export const Rhythm = Extension.create({
  name: 'rhythm',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: rhythmKey,
        state: {
          init: () => ({ pads: [] as number[] }),
          apply(tr, value) {
            const meta = tr.getMeta(rhythmKey) as number[] | undefined;
            return meta ? { pads: meta } : value;
          },
        },
        props: {
          decorations(state) {
            const pads = rhythmKey.getState(state)?.pads ?? [];
            if (!pads.length) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset, index) => {
              const pad = pads[index];
              if (pad && pad > 0.25) {
                decos.push(Decoration.node(offset, offset + node.nodeSize, { style: `margin-bottom:${pad}px` }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
        view(view) {
          let raf = 0;
          const measure = () => {
            raf = 0;
            const dom = view.dom as HTMLElement;
            if (!dom.isConnected || dom.offsetParent === null) return;
            const line = parseFloat(getComputedStyle(dom).getPropertyValue('--line')) || 30;
            const prev = rhythmKey.getState(view.state)?.pads ?? [];
            const pads: number[] = [];
            let changed = prev.length !== view.state.doc.childCount;
            view.state.doc.forEach((_node, offset, index) => {
              const el = view.nodeDOM(offset);
              if (!(el instanceof HTMLElement)) {
                pads.push(0);
                return;
              }
              const mt = parseFloat(getComputedStyle(el).marginTop) || 0;
              const h = el.offsetHeight + mt;
              const total = Math.max(line, Math.ceil((h - 0.5) / line) * line);
              const pad = Math.round((total - h) * 100) / 100;
              pads.push(pad);
              if (Math.abs((prev[index] ?? 0) - pad) > 0.25) changed = true;
            });
            if (changed) view.dispatch(view.state.tr.setMeta(rhythmKey, pads).setMeta('addToHistory', false));
          };
          const schedule = () => {
            if (!raf) raf = requestAnimationFrame(measure);
          };
          const ro = new ResizeObserver(schedule);
          ro.observe(view.dom);
          schedule();
          document.fonts?.ready.then(schedule).catch(() => undefined);
          return {
            update(v, prevState) {
              if (v.state.doc !== prevState.doc) schedule();
            },
            destroy() {
              ro.disconnect();
              if (raf) cancelAnimationFrame(raf);
            },
          };
        },
      }),
    ];
  },
});
