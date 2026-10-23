import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { IndentDecrease, IndentIncrease, List, ListOrdered, TextQuote } from 'lucide-react';
import { cx } from '../../lib/util';

const STYLES = [
  { level: 1, label: 'Heading 1' },
  { level: 2, label: 'Heading 2' },
  { level: 3, label: 'Heading 3' },
  { level: 0, label: 'Text' },
] as const;

/**
 * The Aa panel, Apple Notes' Format sheet: the paragraph style (each name drawn in its own style), then lists,
 * indent and quote. Bold, colour and highlight are in the bubble over selected text, and ⌘B/I/U.
 */
export function FormatPanel({ editor, onDone, more }: { editor: Editor; onDone(): void; more?: React.ReactNode }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const item = e.isActive('taskList') ? 'taskItem' : 'listItem';
      return {
        level: ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
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
      <div className="fmt-row is-blocks">
        <span className="fmt-caps">
          <Seg on={st.bullet} label="Bulleted list" onClick={() => chain().toggleBulletList().run()}>
            <List size={18} />
          </Seg>
          <Seg on={st.ordered} label="Numbered list" onClick={() => chain().toggleOrderedList().run()}>
            <ListOrdered size={18} />
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
      {more}
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
