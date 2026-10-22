import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { buildExtensions } from './extensions';
import { createClipboardSerializer, normalizeDocJSON } from './extensions/blockAttrs';
import { InkLayer, type InkAskRequest, type InkLayerHandle, type InkSession } from './ink/InkLayer';
import { InkToolbar } from './ui/InkToolbar';
import { BubbleMenu, type AskTextRequest } from './ui/BubbleMenu';
import { InkPad, type InkPadState } from './ui/InkPad';
import { PageHeader } from './ui/PageHeader';
import { editorBus } from './bus';
import { editors, inkLayers } from './registry';
import { captureInlineSketch, startTypingFromInk } from './ink/typeFlow';
import { findBlock, inkOf, removeStrokes, replaceBlockWith, setTranscript } from './ink/ops';
import { useVault } from '../state/vault';
import { LINE_PX, PAGE_WIDTH, useSettings } from '../state/settings';
import { useTools } from '../state/tools';
import { useUI } from '../state/ui';
import { useAI, visionModel } from '../state/ai';
import { useAssistant, type Attachment } from '../state/assistant';
import { TEXT_ACTIONS } from '../lib/ai/prompts';
import { blockToText, inkTranscriptText } from '../lib/ai/context';
import { transcribeImage, transcribeStrokes } from '../lib/ai/actions';
import { PreemptedError } from '../lib/ai/engine';
import { captureRegion } from '../lib/ai/vision';
import { rasterizeStrokes } from '../lib/ink/raster';
import type { InkTranscript, Stroke, Tool } from '../lib/ink/types';
import { strokeBounds, translateStroke, unionBounds } from '../lib/ink/geometry';
import { bytesToBase64, cx, debounce } from '../lib/util';
import { toast } from '../components/common/toast';

const TOOL_KEYS: Record<string, Tool> = {
  KeyT: 'text',
  KeyP: 'pen',
  KeyH: 'highlighter',
  KeyE: 'eraser',
  KeyL: 'lasso',
  KeyS: 'shapes',
  KeyA: 'ask',
};

const scrollMemory = new Map<string, number>();

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function NoteEditor({ noteId, active }: { noteId: string; active: boolean }) {
  const note = useVault((s) => s.notes[noteId]);
  const settings = useSettings();
  const zoom = useUI((s) => s.zoom);
  const line = LINE_PX[settings.lineSpacing];
  const pageWidth = PAGE_WIDTH[settings.pageSize];
  const paper = note?.meta.paper ?? settings.paper;
  const tool = useTools((s) => s.tool);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<InkLayerHandle>(null);
  const session = useRef<InkSession>({ recent: [], lastBlockId: null, lastBottom: 0, lastAt: 0 });
  const [fit, setFit] = useState(1);
  const [pageHeight, setPageHeight] = useState(1200);
  const [pad, setPad] = useState<InkPadState | null>(null);
  const scale = Math.round(zoom * (settings.fitWidth ? fit : 1) * 1000) / 1000;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const activeRef = useRef(active);
  activeRef.current = active;

  const save = useMemo(
    () =>
      debounce((ed: Editor) => {
        if (ed.isDestroyed) return;
        useVault.getState().updateContent(noteId, ed.getJSON());
      }, 400),
    [noteId],
  );

  const initialContent = useMemo(
    () => normalizeDocJSON(structuredClone(note?.content ?? { type: 'doc', content: [{ type: 'paragraph' }] }) as never) as JSONContent,
    [noteId],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor(
    {
      extensions: useMemo(buildExtensions, []),
      content: initialContent,
      editorProps: {
        attributes: { class: 'nib-editor', spellcheck: String(settings.spellcheck) },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            const t = useTools.getState();
            if (session.current.lastAt > 0) {
              t.setTool(t.lastInkTool === 'ask' ? 'pen' : t.lastInkTool);
              (editor?.view.dom as HTMLElement | undefined)?.blur();
              return true;
            }
            return false;
          }
          // Stylus users: wrote right after the line they are typing? fold it in.
          if (session.current.recent.length && event.key.length === 1 && !event.metaKey && !event.ctrlKey && editor && wrapRef.current && inkRef.current) {
            captureInlineSketch(
              { editor, layout: inkRef.current.layout(), session: session.current, scale: scaleRef.current, line, wrap: wrapRef.current },
              { onlyIfCaretThere: true },
            );
            session.current.recent = [];
          }
          return false;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (!files.length) return false;
          event.preventDefault();
          void insertImages(files, view.state.selection.from);
          return true;
        },
        handleDrop: (view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (!files.length) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos ?? view.state.selection.from;
          void insertImages(files, pos);
          return true;
        },
      },
      onUpdate: ({ editor: ed }) => save(ed),
      onBlur: () => save.flush(),
    },
    [noteId],
  );

  const insertImages = async (files: File[], pos: number) => {
    if (!editor) return;
    for (const f of files) {
      if (f.size > 12 * 1024 * 1024) {
        toast.error('Image too large', 'Images up to 12 MB can be embedded in a note.');
        continue;
      }
      const src = await readFileAsDataURL(f);
      editor
        .chain()
        .focus()
        .insertContentAt(pos, { type: 'image', attrs: { src, alt: f.name } })
        .run();
    }
  };

  // Registry + clipboard serializer that keeps ink.
  useEffect(() => {
    if (!editor) return;
    editors.set(noteId, editor);
    editor.view.setProps({ clipboardSerializer: createClipboardSerializer(editor.schema) });
    return () => {
      save.flush();
      if (editors.get(noteId) === editor) editors.delete(noteId);
    };
  }, [editor, noteId, save]);

  useEffect(() => {
    if (inkRef.current) inkLayers.set(noteId, inkRef.current);
    return () => {
      inkLayers.delete(noteId);
    };
  });

  // Fit the page to the window, but never below 70% (11px body text): past that the text can't be read, so a
  // narrower column scrolls sideways instead, as Google Docs does. 70% still fits the 1024px window with the
  // assistant open and the drawer as a rail.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth) return;
      const avail = el.clientWidth - 48;
      const next = Math.min(1, Math.max(0.7, avail / pageWidth));
      // Ignore sub-pixel jitter so resizing can never ping-pong.
      setFit((cur) => (Math.abs(cur - next) < 0.004 ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWidth]);

  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPageHeight((h) => (Math.abs(h - el.offsetHeight) < 1 ? h : el.offsetHeight)));
    ro.observe(el);
    setPageHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // Remember scroll position per note.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (active) {
      requestAnimationFrame(() => (el.scrollTop = scrollMemory.get(noteId) ?? 0));
      const onScroll = () => scrollMemory.set(noteId, el.scrollTop);
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => el.removeEventListener('scroll', onScroll);
    }
  }, [active, noteId]);

  // Pinch / ctrl-wheel zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const ui = useUI.getState();
      ui.setZoom(ui.zoom * (1 - e.deltaY * 0.01));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Reveal a block (from a citation or search hit): scroll to it and flash an
  // overlay behind it (an overlay, because ProseMirror owns the block's DOM).
  const reveal = useUI((s) => s.reveal);
  const [flash, setFlash] = useState<{ top: number; height: number; at: number } | null>(null);
  useEffect(() => {
    if (!active || !reveal || reveal.noteId !== noteId || !editor) return;
    const t = setTimeout(() => {
      const el = editor.view.dom.querySelector(`[data-id="${CSS.escape(reveal.blockId)}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const pm = editor.view.dom as HTMLElement;
      setFlash({ top: pm.offsetTop + el.offsetTop, height: el.offsetHeight, at: reveal.at });
    }, 120);
    return () => clearTimeout(t);
  }, [reveal, active, noteId, editor]);
  useEffect(() => {
    if (!flash) return;
    if (!active) {
      setFlash(null);
      return;
    }
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash, active]);

  // Keyboard: ⌥-letter tools, "just start typing" after ink, Esc.
  useEffect(() => {
    if (!active || !editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const inField = !!target.closest?.('input, textarea, select, [contenteditable="true"]');
      if (e.altKey && !e.metaKey && !e.ctrlKey && TOOL_KEYS[e.code]) {
        if (inField && !target.closest('.ProseMirror')) return;
        e.preventDefault();
        const next = TOOL_KEYS[e.code];
        useTools.getState().setTool(next);
        if (next === 'text') editor.commands.focus();
        else (editor.view.dom as HTMLElement).blur();
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.modal-backdrop, .inkpad-backdrop, .popover, .context-menu')) return;
      const t = useTools.getState();
      if (t.tool === 'text') return;
      if (inkRef.current?.hasSelection()) return;
      const printable = e.key.length === 1;
      if (!printable && e.key !== 'Enter') return;
      e.preventDefault();
      startTypingFromInk(
        { editor, layout: inkRef.current!.layout(), session: session.current, scale: scaleRef.current, line, wrap: wrapRef.current! },
        printable ? e.key : '',
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editor, line]);

  // ------------------------------------------------------------ AI hooks
  const assistantAsk = useCallback(
    (opts: { prompt?: string; label?: string; mode?: InkAskRequest['mode']; attachments: Omit<Attachment, 'id'>[]; anchor?: string }) => {
      useUI.getState().setAssistant(true);
      const attachments = opts.attachments.map((a, i) => ({ ...a, id: `att${Date.now()}${i}` }));
      void useAssistant.getState().ask(noteId, { prompt: opts.prompt, label: opts.label, mode: opts.mode, attachments, anchor: opts.anchor });
    },
    [noteId],
  );

  const onInkAsk = useCallback(
    (req: InkAskRequest) => {
      if (!editor) return;
      const doc = editor.state.doc;
      const attachments: Omit<Attachment, 'id'>[] = [];
      const isArea = req.label === 'Area of the page';
      let image = req.image ?? null;
      let imageLabel = req.label;
      if (!image && req.strokes.length) {
        // No screen capture (browser build): send the handwriting itself.
        image = rasterizeStrokes(req.strokes);
        if (isArea) imageLabel = 'Handwriting in that area';
      }
      if (image) attachments.push({ kind: 'image', label: imageLabel, image });
      // Typed text and transcripts of the blocks involved.
      const texts: string[] = [];
      for (const id of req.blockIds) {
        const f = findBlock(doc, id);
        if (!f) continue;
        const json = f.node.toJSON() as JSONContent;
        const t = f.node.type.name === 'inkBlock' ? inkTranscriptText(f.node.attrs.transcript as InkTranscript) : blockToText(json);
        if (t?.trim()) texts.push(t);
      }
      if (texts.length) attachments.push({ kind: 'text', label: isArea ? 'Text in that area' : 'What Nib read', text: texts.join('\n\n') });
      if (!attachments.length) {
        toast.info('Nothing to ask about', 'Select some handwriting or drag over part of the page.');
        return;
      }
      assistantAsk({ prompt: req.prompt, mode: req.mode, attachments, anchor: req.blockIds[req.blockIds.length - 1] });
      if (req.label === 'Area of the page') useTools.getState().setTool(useTools.getState().lastInkTool);
    },
    [editor, assistantAsk],
  );

  const blockStrokesAbs = (blockId: string): Stroke[] => {
    if (!editor) return [];
    const f = findBlock(editor.state.doc, blockId);
    return f ? (inkOf(f.node) as Stroke[]) : [];
  };

  /** Turns handwriting into typed text or typeset math (via the local vision model). */
  const convertInk = useCallback(
    async (
      strokes: Stroke[],
      to: 'text' | 'math',
      place: { afterBlockId: string; removeBlockId?: string; removeStrokes?: Map<string, Set<string>> },
    ) => {
      if (!editor) return;
      if (!visionModel()) {
        toast.error('No vision model', 'Converting handwriting needs a model that can read images (e.g. qwen2.5vl, gemma3). Set one in Settings → Local AI.');
        return;
      }
      const id = toast.info(to === 'math' ? 'Reading your math…' : 'Reading your handwriting…', `Using ${visionModel()}`);
      try {
        const t = await transcribeStrokes(strokes);
        if (!t) return;
        const schema = editor.schema;
        let nodes: PMNode[] = [];
        if (to === 'math') {
          const latex = t.latex || t.text.replace(/^\$+|\$+$/g, '');
          nodes = latex
            .split(/\\\\\s*\n?|\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => schema.nodes.mathBlock.create({ latex: l.replace(/&/g, '') }));
          if (nodes.length > 1 && /&/.test(latex)) nodes = [schema.nodes.mathBlock.create({ latex: `\\begin{aligned}${latex}\\end{aligned}` })];
        } else {
          const { markdownToEditorHTML } = await import('../lib/ai/markdown');
          const html = markdownToEditorHTML(t.text || t.description || '');
          const { DOMParser } = await import('@tiptap/pm/model');
          const div = document.createElement('div');
          div.innerHTML = html;
          nodes = [];
          DOMParser.fromSchema(schema)
            .parse(div)
            .forEach((n) => nodes.push(n));
        }
        if (!nodes.length) {
          toast.info('Nothing recognised', 'The model could not read that handwriting.');
          return;
        }
        if (place.removeBlockId) {
          replaceBlockWith(editor, place.removeBlockId, nodes);
        } else {
          // The text goes in and the handwriting comes out of every block it was in: one undo step.
          const tr = editor.state.tr;
          if (place.removeStrokes) removeStrokes(tr, place.removeStrokes);
          const f = findBlock(tr.doc, place.afterBlockId);
          if (f) tr.insert(f.pos + f.node.nodeSize, nodes);
          editor.view.dispatch(closeHistory(tr));
        }
        toast.success(to === 'math' ? 'Typeset your math' : 'Converted to text', 'Undo with ⌘Z if it isn’t right.');
      } catch (e) {
        toast.error('Couldn’t read the handwriting', String((e as Error).message ?? e));
      } finally {
        void id;
      }
    },
    [editor],
  );

  useEffect(() => {
    if (!editor) return;
    const offs = [
      editorBus.on('ink:ask', ({ editor: ed, blockId, mode }) => {
        if (ed !== editor) return;
        const strokes = blockStrokesAbs(blockId);
        onInkAsk({ mode, strokes, blockIds: [blockId], label: 'Handwriting', image: rasterizeStrokes(strokes) });
      }),
      editorBus.on('ink:transcribe', async ({ editor: ed, blockId }) => {
        if (ed !== editor) return;
        if (!visionModel()) {
          toast.error('No vision model', 'Reading handwriting needs a model that can see images. Set one in Settings → Local AI.');
          return;
        }
        try {
          toast.info('Reading handwriting…');
          const t = await transcribeStrokes(blockStrokesAbs(blockId));
          if (t) setTranscript(editor, blockId, t);
          toast.success('Handwriting read', t?.text?.slice(0, 80));
        } catch (e) {
          toast.error('Couldn’t read the handwriting', String((e as Error).message ?? e));
        }
      }),
      editorBus.on('ink:convert', ({ editor: ed, blockId, to }) => {
        if (ed !== editor) return;
        void convertInk(blockStrokesAbs(blockId), to, { afterBlockId: blockId, removeBlockId: blockId });
      }),
      editorBus.on('inlineInk:open', ({ editor: ed, pos }) => {
        if (ed !== editor) return;
        setPad({ editor, pos });
      }),
      editorBus.on('math:ask', ({ editor: ed, latex, mode, blockId }) => {
        if (ed !== editor) return;
        assistantAsk({ mode, attachments: [{ kind: 'text', label: 'Equation', text: `$$${latex}$$` }], anchor: blockId });
      }),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onInkAsk, convertInk, assistantAsk]);

  // Image picker from the slash menu.
  useEffect(() => {
    if (!active || !editor) return;
    const onPick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => void insertImages(Array.from(input.files ?? []), editor.state.selection.from);
      input.click();
    };
    window.addEventListener('nib:pick-image', onPick);
    return () => window.removeEventListener('nib:pick-image', onPick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editor]);

  // Background: read handwriting so it is searchable and in the AI's context.
  useAutoTranscribe(editor, active);

  const onAskText = (req: AskTextRequest) => {
    const prompt = req.action === 'custom' ? req.question : TEXT_ACTIONS[req.action];
    const { $to } = editor!.state.selection;
    const anchor = ($to.depth > 0 ? $to.node(1) : null)?.attrs.id as string | undefined;
    assistantAsk({
      prompt,
      // The student's bubble names the action they picked, not the instructions the model gets.
      label: req.action === 'custom' ? undefined : req.label,
      mode: req.action === 'explain' ? 'explain' : 'custom',
      attachments: [{ kind: 'text', label: 'Selected text', text: req.text }],
      anchor,
    });
  };

  const onTailPointerDown = (e: React.PointerEvent) => {
    if (!editor || useTools.getState().tool !== 'text') return;
    if (e.pointerType === 'pen' && useTools.getState().stylusDraws) return;
    e.preventDefault();
    const doc = editor.state.doc;
    const last = doc.lastChild;
    if (last && last.type.name === 'paragraph' && last.content.size === 0) {
      editor.chain().focus('end').run();
    } else {
      editor.chain().insertContentAt(doc.content.size, { type: 'paragraph' }).focus('end').run();
    }
  };

  if (!note || !editor) return null;

  const pageStyle = {
    width: pageWidth,
    transform: `scale(${scale})`,
    ['--line' as string]: `${line}px`,
  } as React.CSSProperties;

  return (
    <div className={cx('note-view', !active && 'is-hidden')} data-note={noteId}>
      <div className="note-scroll" ref={scrollRef}>
        <div className="toolbar-dock">
          <InkToolbar editor={editor} note={note} />
        </div>
        <div className="page-scaler" style={{ width: pageWidth * scale, height: pageHeight * scale + 80 }}>
          <div
            ref={pageRef}
            className={cx('page', `paper-${paper}`, `font-${settings.font}`, `tool-${tool}`, tool !== 'text' && 'is-inking')}
            style={pageStyle}
          >
            <PageHeader note={note} editor={editor} />
            <div className="surface">
              <div className="editor-wrap" ref={wrapRef}>
                <EditorContent editor={editor} />
                <InkLayer
                  ref={inkRef}
                  editor={editor}
                  wrapRef={wrapRef}
                  scale={scale}
                  line={line}
                  session={session}
                  onAsk={onInkAsk}
                  captureRegion={captureRegion}
                  onConvert={({ to, strokes, selection }) => {
                    const bb = unionBounds(strokes.map(strokeBounds));
                    if (!bb) return;
                    const layout = inkRef.current!.layout();
                    const byBlock = new Map<string, Set<string>>();
                    for (const it of selection) {
                      if (!byBlock.has(it.blockId)) byBlock.set(it.blockId, new Set());
                      byBlock.get(it.blockId)!.add(it.strokeId);
                    }
                    // The typed version goes below the last block the handwriting was in.
                    const blocks = layout.blocks.filter((b) => byBlock.has(b.id));
                    const blk = blocks[blocks.length - 1];
                    if (!blk) return;
                    const local = strokes.map((s) => translateStroke(s, 0, -blk.top));
                    inkRef.current?.clearSelection();
                    void convertInk(local, to, { afterBlockId: blk.id, removeStrokes: byBlock });
                  }}
                />
                {flash && <div key={flash.at} className="nib-flash-box" style={{ top: flash.top - 4, height: flash.height + 8 }} />}
                <div className="page-tail" onPointerDown={onTailPointerDown} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {active && <BubbleMenu editor={editor} onAsk={onAskText} />}
      {pad && (
        <InkPad
          state={pad}
          onClose={() => setPad(null)}
          onPopOut={(pos) => {
            setPad(null);
            inkRef.current?.popOut(pos);
          }}
        />
      )}
    </div>
  );
}

/** Reads handwriting areas in the background with the local vision model. */
function useAutoTranscribe(editor: Editor | null, active: boolean) {
  useEffect(() => {
    if (!editor || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let cancelled = false;
    const failed = new Set<string>();
    const check = async () => {
      const ai = useAI.getState();
      if (cancelled || busy || !ai.autoTranscribe || ai.status !== 'online' || !visionModel()) return;
      if (useAssistant.getState().streaming) {
        timer = setTimeout(check, 6000);
        return;
      }
      let target: { id: string; strokes: Stroke[] } | null = null;
      editor.state.doc.forEach((n) => {
        if (target || n.type.name !== 'inkBlock') return;
        const ink = inkOf(n) as Stroke[];
        const t = n.attrs.transcript as InkTranscript | null;
        if (ink.length && (!t || t.stale) && !failed.has(n.attrs.id)) target = { id: n.attrs.id, strokes: ink };
      });
      if (!target) return;
      const { id, strokes } = target as { id: string; strokes: Stroke[] };
      busy = true;
      let retryIn = 1500;
      try {
        const image = rasterizeStrokes(strokes, null, { maxSide: 1280, minScale: 1.5 });
        if (image) {
          // Background priority: a question from the student pre-empts this and it simply retries later.
          const t = await transcribeImage(image, undefined, 'background');
          if (!cancelled && !editor.isDestroyed) setTranscript(editor, id, t);
        }
      } catch (e) {
        if (e instanceof PreemptedError) retryIn = 8000;
        else failed.add(id);
      } finally {
        busy = false;
        if (!cancelled) timer = setTimeout(check, retryIn);
      }
    };
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 4500);
    };
    editor.on('update', onUpdate);
    timer = setTimeout(check, 2500);
    return () => {
      cancelled = true;
      editor.off('update', onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor, active]);
}

export { bytesToBase64 };
