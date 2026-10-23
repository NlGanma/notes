import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { posToDOMRect } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  Baseline,
  Bold,
  BookOpenText,
  Check,
  ChevronDown,
  Code,
  Italic,
  Languages,
  Lightbulb,
  Link2,
  MessageCircleQuestion,
  PenLine,
  Radical,
  Sprout,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { cx } from '../../lib/util';
import { MOD } from '../../lib/platform';
import { BG_COLORS, TEXT_COLORS } from './palette';

export interface AskTextRequest {
  text: string;
  action: 'explain' | 'simplify' | 'example' | 'define' | 'rewrite' | 'translate' | 'custom';
  question?: string;
  /** The menu item's name, shown as the student's question (the model gets the action's full prompt). */
  label?: string;
}

const AI_ACTIONS: { id: AskTextRequest['action']; label: string; icon: typeof MessageCircleQuestion }[] = [
  { id: 'explain', label: 'Explain this', icon: Lightbulb },
  { id: 'simplify', label: 'Explain like I’m new to it', icon: Sprout },
  { id: 'example', label: 'Give an example', icon: BookOpenText },
  { id: 'define', label: 'Define key terms', icon: Baseline },
  { id: 'rewrite', label: 'Tidy up the wording', icon: PenLine },
  { id: 'translate', label: 'Translate', icon: Languages },
];

type Panel = null | 'ai' | 'color' | 'link';

/**
 * Floating bar for a text selection: Ask | Link | B I U S code math | A ▾. Ask looks like every other button.
 * The paragraph style isn't here: it is the tool bar's Aa (and the slash menu).
 */
export function BubbleMenu({ editor, onAsk }: { editor: Editor; onAsk(req: AskTextRequest): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [panelLeft, setPanelLeft] = useState(0);
  const [panelUp, setPanelUp] = useState(false);
  const [link, setLink] = useState('');
  const [mouseDown, setMouseDown] = useState(false);
  /** Focus is inside the bubble (e.g. its question field) — keep it open. */
  const [inside, setInside] = useState(false);

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      const hasSel = !sel.empty && !(sel instanceof NodeSelection) && !e.isActive('codeBlock');
      return {
        hasSel,
        focused: e.isFocused,
        from: sel.from,
        to: sel.to,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        highlight: e.isActive('highlight'),
        color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
        bg: (e.getAttributes('highlight').color as string | undefined) ?? '',
      };
    },
  });

  // Don't pop up while the user is still dragging a selection.
  useEffect(() => {
    const dom = editor.view.dom;
    const down = () => setMouseDown(true);
    const up = () => setMouseDown(false);
    dom.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      dom.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, [editor]);

  const show = st.hasSel && (st.focused || inside);

  // Only when the bubble hides: this must not set state on every caret move while typing,
  // or React counts one nested update per keystroke and warns after 50.
  useEffect(() => {
    if (!show) setPanel(null);
  }, [show]);

  useEffect(() => {
    if (!show) return;
    // Centre on the selection's box. posToDOMRect spans first caret to last caret, which on a multi-line
    // selection can sit far off-centre; a DOM range measures the text itself.
    let r: { left: number; width: number; top: number; bottom: number } = posToDOMRect(editor.view, st.from, st.to);
    try {
      const a = editor.view.domAtPos(st.from);
      const b = editor.view.domAtPos(st.to);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const box = range.getBoundingClientRect();
      if (box.width || box.height) r = box;
    } catch {
      /* keep the caret-to-caret rect */
    }
    const el = ref.current;
    const w = el?.querySelector('.bubble-row')?.getBoundingClientRect().width ?? 460;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    // 8px above the selection; below it when there is no room under the toolbar.
    let top = r.top - 36 - 8;
    if (top < 120) top = r.bottom + 8;
    setPos({ left, top });
    // mouseDown: measure the real bar width once it renders after the drag ends.
  }, [show, st.from, st.to, editor, mouseDown]);

  if (!show || mouseDown) return null;

  const selectedText = () => editor.state.doc.textBetween(st.from, st.to, '\n', '￼');
  const toggle = (p: Panel, e: React.MouseEvent<HTMLElement>) => {
    setPanelLeft(e.currentTarget.offsetLeft);
    // Drop down under the bar, or up over it when the window has no room below.
    const bar = ref.current?.getBoundingClientRect();
    setPanelUp(!!bar && bar.bottom + 380 > window.innerHeight && bar.top > 380);
    setPanel(panel === p ? null : p);
  };
  const mark = (on: boolean, label: string, icon: ReactNode, run: () => void) => (
    <button className={cx('bub-btn is-icon', on && 'is-on')} onClick={run} title={label} aria-label={label} aria-pressed={on}>
      {icon}
    </button>
  );

  return createPortal(
    <div
      ref={ref}
      className={cx('bubble', panelUp && 'is-up')}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (panel) setPanel(null);
          else editor.commands.focus();
        }
      }}
      onFocusCapture={() => setInside(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
      }}
      data-ui
    >
      <div className="bubble-row">
        <button className={cx('bub-btn is-ai', panel === 'ai' && 'is-open')} onClick={(e) => toggle('ai', e)} aria-haspopup="menu">
          <MessageCircleQuestion size={16} />
          Ask
          <ChevronDown size={12} />
        </button>
        <span className="bub-sep" />
        <button
          className={cx('bub-btn', (st.link || panel === 'link') && 'is-open', st.link && 'is-on')}
          onClick={(e) => {
            setLink((editor.getAttributes('link').href as string) ?? '');
            toggle('link', e);
          }}
          title={`Link  ${MOD}K`}
        >
          <Link2 size={16} />
          Link
        </button>
        <span className="bub-sep" />
        {mark(st.bold, `Bold  ${MOD}B`, <Bold size={16} />, () => editor.chain().focus().toggleBold().run())}
        {mark(st.italic, `Italic  ${MOD}I`, <Italic size={16} />, () => editor.chain().focus().toggleItalic().run())}
        {mark(st.underline, `Underline  ${MOD}U`, <Underline size={16} />, () => editor.chain().focus().toggleUnderline().run())}
        {mark(st.strike, `Strikethrough  ⇧${MOD}X`, <Strikethrough size={16} />, () => editor.chain().focus().toggleStrike().run())}
        {mark(st.code, `Code  ${MOD}E`, <Code size={16} />, () => editor.chain().focus().toggleCode().run())}
        {mark(false, `Math  ⇧${MOD}M`, <Radical size={16} />, () => {
          const text = selectedText();
          editor
            .chain()
            .focus()
            .insertContentAt({ from: st.from, to: st.to }, { type: 'mathInline', attrs: { latex: text } })
            .run();
        })}
        <span className="bub-sep" />
        <button className={cx('bub-btn bub-color', panel === 'color' && 'is-open')} onClick={(e) => toggle('color', e)} title="Color" aria-haspopup="menu">
          <span className="bub-a" style={{ color: st.color || undefined, background: st.bg || undefined }}>
            A
          </span>
          <ChevronDown size={12} />
        </button>
      </div>

      {panel === 'ai' && (
        <div className="bubble-panel is-ask" style={{ left: panelLeft }}>
          {AI_ACTIONS.map((a) => (
            <button
              key={a.id}
              className="menu-item"
              onClick={() => {
                setPanel(null);
                onAsk({ text: selectedText(), action: a.id, label: a.label });
              }}
            >
              <a.icon size={20} />
              <span className="menu-label">{a.label}</span>
            </button>
          ))}
          <form
            className="bubble-ask"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q') as string;
              if (q?.trim()) {
                setPanel(null);
                onAsk({ text: selectedText(), action: 'custom', question: q.trim() });
              }
            }}
          >
            <input name="q" placeholder="Ask anything about the selection…" autoFocus onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()} />
          </form>
        </div>
      )}

      {panel === 'color' && (
        <div className="bubble-panel is-colors" style={{ left: panelLeft }}>
          <div className="bubble-label">Text color</div>
          {TEXT_COLORS.map((c) => (
            <button
              key={c.name}
              className="menu-item"
              onClick={() => (c.value ? editor.chain().focus().setColor(c.value).run() : editor.chain().focus().unsetColor().run())}
            >
              <span className="color-tile" style={{ color: c.value || 'var(--text)' }}>
                A
              </span>
              <span className="menu-label">{c.name === 'Default' ? 'Default text' : c.name}</span>
              {st.color === c.value && <Check size={18} className="bubble-check" />}
            </button>
          ))}
          <div className="bubble-label">Background color</div>
          {BG_COLORS.map((c) => {
            const on = c.value ? st.bg === c.value : !st.highlight;
            return (
              <button
                key={c.name}
                className="menu-item"
                onClick={() => (c.value ? editor.chain().focus().setHighlight({ color: c.value }).run() : editor.chain().focus().unsetHighlight().run())}
              >
                <span className={cx('color-tile', !c.value && 'is-default')} style={{ background: c.value || undefined }}>
                  A
                </span>
                <span className="menu-label">
                  {c.name === 'Default' ? 'Default background' : c.name === 'Highlight' ? 'Highlighter' : `${c.name} background`}
                </span>
                {on && <Check size={18} className="bubble-check" />}
              </button>
            );
          })}
        </div>
      )}

      {panel === 'link' && (
        <form
          className="bubble-panel bubble-link"
          style={{ left: panelLeft }}
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) editor.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run();
            else editor.chain().focus().extendMarkRange('link').unsetLink().run();
            setPanel(null);
          }}
        >
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Paste a link…"
            autoFocus
            onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()}
          />
          <button type="submit" className="btn is-small is-ghost">
            {link.trim() || !st.link ? 'Apply' : 'Remove'}
          </button>
        </form>
      )}
    </div>,
    document.body,
  );
}
