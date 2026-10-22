import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { posToDOMRect } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  Bold,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  Lightbulb,
  Link2,
  MessageCircleQuestion,
  Radical,
  Sparkles,
  Strikethrough,
  Underline,
  Wand2,
  Languages,
  BookOpenText,
  Baseline,
} from 'lucide-react';
import { TEXT_COLORS, TEXT_HIGHLIGHTS } from '../../lib/ink/brushes';
import { cx } from '../../lib/util';
import { MOD } from '../../lib/platform';

export interface AskTextRequest {
  text: string;
  action: 'explain' | 'simplify' | 'example' | 'define' | 'rewrite' | 'translate' | 'custom';
  question?: string;
  /** The menu item's name, shown as the student's question (the model gets the action's full prompt). */
  label?: string;
}

const AI_ACTIONS: { id: AskTextRequest['action']; label: string; icon: typeof Sparkles }[] = [
  { id: 'explain', label: 'Explain this', icon: Lightbulb },
  { id: 'simplify', label: 'Explain like I’m new to it', icon: MessageCircleQuestion },
  { id: 'example', label: 'Give an example', icon: BookOpenText },
  { id: 'define', label: 'Define key terms', icon: Baseline },
  { id: 'rewrite', label: 'Tidy up the wording', icon: Wand2 },
  { id: 'translate', label: 'Translate', icon: Languages },
];

/** Floating formatting bar for a text selection, with "Ask AI" built in. */
export function BubbleMenu({ editor, onAsk }: { editor: Editor; onAsk(req: AskTextRequest): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [panel, setPanel] = useState<null | 'ai' | 'color' | 'link'>(null);
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
    const r = posToDOMRect(editor.view, st.from, st.to);
    const el = ref.current;
    const w = el?.offsetWidth ?? 420;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    let top = r.top - 48;
    if (top < 60) top = r.bottom + 10;
    setPos({ left, top });
  }, [show, st.from, st.to, editor, panel]);

  if (!show || mouseDown) return null;

  const selectedText = () => editor.state.doc.textBetween(st.from, st.to, '\n', '￼');

  return createPortal(
    <div
      ref={ref}
      className="bubble"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
      onFocusCapture={() => setInside(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
      }}
      data-ui
    >
      <div className="bubble-row">
        <button className={cx('bub-btn is-ai', panel === 'ai' && 'is-on')} onClick={() => setPanel(panel === 'ai' ? null : 'ai')}>
          <Sparkles size={14} /> Ask AI <ChevronDown size={12} />
        </button>
        <span className="bub-sep" />
        <button className={cx('bub-btn', st.bold && 'is-on')} onClick={() => editor.chain().focus().toggleBold().run()} title={`Bold ${MOD}B`}>
          <Bold size={15} />
        </button>
        <button className={cx('bub-btn', st.italic && 'is-on')} onClick={() => editor.chain().focus().toggleItalic().run()} title={`Italic ${MOD}I`}>
          <Italic size={15} />
        </button>
        <button className={cx('bub-btn', st.underline && 'is-on')} onClick={() => editor.chain().focus().toggleUnderline().run()} title={`Underline ${MOD}U`}>
          <Underline size={15} />
        </button>
        <button className={cx('bub-btn', st.strike && 'is-on')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
          <Strikethrough size={15} />
        </button>
        <button className={cx('bub-btn', st.code && 'is-on')} onClick={() => editor.chain().focus().toggleCode().run()} title={`Code ${MOD}E`}>
          <Code size={15} />
        </button>
        <button
          className="bub-btn"
          title="Turn into math"
          onClick={() => {
            const text = selectedText();
            editor
              .chain()
              .focus()
              .insertContentAt({ from: st.from, to: st.to }, { type: 'mathInline', attrs: { latex: text } })
              .run();
          }}
        >
          <Radical size={15} />
        </button>
        <button
          className={cx('bub-btn', (st.highlight || panel === 'color') && 'is-on')}
          onClick={() => setPanel(panel === 'color' ? null : 'color')}
          title="Colour & highlight"
        >
          <Highlighter size={15} />
        </button>
        <button
          className={cx('bub-btn', (st.link || panel === 'link') && 'is-on')}
          onClick={() => {
            setLink((editor.getAttributes('link').href as string) ?? '');
            setPanel(panel === 'link' ? null : 'link');
          }}
          title="Link"
        >
          <Link2 size={15} />
        </button>
      </div>

      {panel === 'ai' && (
        <div className="bubble-panel">
          {AI_ACTIONS.map((a) => (
            <button
              key={a.id}
              className="menu-item"
              onClick={() => {
                setPanel(null);
                onAsk({ text: selectedText(), action: a.id, label: a.label });
              }}
            >
              <a.icon size={15} />
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
            <input name="q" placeholder="Ask anything about the selection…" autoFocus onKeyDown={(e) => e.stopPropagation()} />
          </form>
        </div>
      )}

      {panel === 'color' && (
        <div className="bubble-panel is-colors">
          <div className="pop-label">Text colour</div>
          <div className="swatch-row">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.name}
                className="swatch is-text"
                title={c.name}
                onClick={() => (c.value ? editor.chain().focus().setColor(c.value).run() : editor.chain().focus().unsetColor().run())}
              >
                <span style={{ color: c.value || 'var(--text)' }}>A</span>
              </button>
            ))}
          </div>
          <div className="pop-label">Highlight</div>
          <div className="swatch-row">
            {TEXT_HIGHLIGHTS.map((c) => (
              <button key={c.value} className="swatch" title={c.name} onClick={() => editor.chain().focus().toggleHighlight({ color: c.value }).run()}>
                <span style={{ background: c.value }} />
              </button>
            ))}
            <button className="swatch is-none" title="Remove highlight" onClick={() => editor.chain().focus().unsetHighlight().run()}>
              <span />
            </button>
          </div>
        </div>
      )}

      {panel === 'link' && (
        <form
          className="bubble-panel bubble-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) editor.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run();
            else editor.chain().focus().extendMarkRange('link').unsetLink().run();
            setPanel(null);
          }}
        >
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a link…" autoFocus onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit" className="btn is-small">
            Save
          </button>
        </form>
      )}
    </div>,
    document.body,
  );
}
