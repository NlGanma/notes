import { useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Check, Highlighter, IndentDecrease, IndentIncrease, List, ListChecks, ListOrdered, TextQuote } from 'lucide-react';
import { cx } from '../../lib/util';
import { MOD } from '../../lib/platform';
import { BG_COLORS, TEXT_COLORS } from './palette';

const STYLES = [
  { level: 1, label: 'Heading 1' },
  { level: 2, label: 'Heading 2' },
  { level: 3, label: 'Heading 3' },
  { level: 0, label: 'Text' },
] as const;

/**
 * The Aa panel: Apple Notes' Format sheet at Mac size. Row 1 is the paragraph style (each name drawn in its
 * own style), row 2 the marks and colours, row 3 lists, indent and quote, as segmented capsules.
 */
export function FormatPanel({ editor, onDone }: { editor: Editor; onDone(): void }) {
  const [colors, setColors] = useState(false);
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const item = e.isActive('taskList') ? 'taskItem' : 'listItem';
      return {
        level: ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        highlight: e.isActive('highlight'),
        color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
        hlColor: (e.getAttributes('highlight').color as string | undefined) ?? '',
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        task: e.isActive('taskList'),
        quote: e.isActive('blockquote'),
        canIndent: e.can().sinkListItem(item),
        canOutdent: e.can().liftListItem(item),
        item,
      };
    },
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="fmt-panel">
      <div className="fmt-styles" role="radiogroup" aria-label="Paragraph style">
        {STYLES.map((s) => (
          <button
            key={s.label}
            role="radio"
            aria-checked={st.level === s.level}
            className={cx('fmt-style', `is-h${s.level}`, st.level === s.level && 'is-active')}
            onClick={() => {
              if (s.level) chain().setHeading({ level: s.level }).run();
              else chain().setParagraph().run();
              onDone();
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="fmt-row is-marks">
        <span className="fmt-caps">
          <Seg on={st.bold} label={`Bold  ${MOD}B`} onClick={() => chain().toggleBold().run()}>
            <b>B</b>
          </Seg>
          <Seg on={st.italic} label={`Italic  ${MOD}I`} onClick={() => chain().toggleItalic().run()}>
            <i>I</i>
          </Seg>
          <Seg on={st.underline} label={`Underline  ${MOD}U`} onClick={() => chain().toggleUnderline().run()}>
            <u>U</u>
          </Seg>
          <Seg on={st.strike} label={`Strikethrough  ⇧${MOD}X`} onClick={() => chain().toggleStrike().run()}>
            <s>S</s>
          </Seg>
        </span>
        <span className="fmt-caps">
          <Seg on={st.highlight} label="Highlight" onClick={() => setColors((v) => !v)}>
            <span className="fmt-marker">
              <Highlighter size={18} />
              <span style={{ background: st.hlColor || BG_COLORS[1].value }} />
            </span>
          </Seg>
          <Seg on={colors} label="Text colour" onClick={() => setColors((v) => !v)}>
            <span className="fmt-dot" style={{ background: st.color || 'var(--text)' }} />
          </Seg>
        </span>
      </div>
      {colors && (
        <div className="fmt-colors">
          <div className="fmt-colors-label">Text colour</div>
          <div className="fmt-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.name}
                className={cx('fmt-swatch is-text', st.color === c.value && 'is-active')}
                title={c.name}
                style={{ color: c.value || 'var(--text)' }}
                onClick={() => (c.value ? chain().setColor(c.value).run() : chain().unsetColor().run())}
              >
                A
              </button>
            ))}
          </div>
          <div className="fmt-colors-label">Highlight</div>
          <div className="fmt-swatches">
            {BG_COLORS.map((c) => (
              <button
                key={c.name}
                className={cx('fmt-swatch', (c.value ? st.hlColor === c.value : !st.highlight) && 'is-active', !c.value && 'is-none')}
                title={c.name}
                style={{ background: c.value || undefined }}
                onClick={() => (c.value ? chain().setHighlight({ color: c.value }).run() : chain().unsetHighlight().run())}
              >
                {(c.value ? st.hlColor === c.value : !st.highlight) && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="fmt-row is-blocks">
        <span className="fmt-caps">
          <Seg on={st.bullet} label="Bulleted list" onClick={() => chain().toggleBulletList().run()}>
            <List size={18} />
          </Seg>
          <Seg on={st.ordered} label="Numbered list" onClick={() => chain().toggleOrderedList().run()}>
            <ListOrdered size={18} />
          </Seg>
          <Seg on={st.task} label="Checklist" onClick={() => chain().toggleTaskList().run()}>
            <ListChecks size={18} />
          </Seg>
        </span>
        <span className="fmt-caps">
          <Seg disabled={!st.canOutdent} label="Outdent  ⇧Tab" onClick={() => chain().liftListItem(st.item).run()}>
            <IndentDecrease size={18} />
          </Seg>
          <Seg disabled={!st.canIndent} label="Indent  Tab" onClick={() => chain().sinkListItem(st.item).run()}>
            <IndentIncrease size={18} />
          </Seg>
        </span>
        <span className="fmt-caps">
          <Seg on={st.quote} label="Quote" onClick={() => chain().toggleBlockquote().run()}>
            <TextQuote size={18} />
          </Seg>
        </span>
      </div>
    </div>
  );
}

function Seg({ on, disabled, label, onClick, children }: { on?: boolean; disabled?: boolean; label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button className={cx('fmt-seg', on && 'is-on')} disabled={disabled} onClick={onClick} aria-label={label} aria-pressed={on} title={label}>
      {children}
    </button>
  );
}
