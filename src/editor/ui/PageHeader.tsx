import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ChevronDown, Folder, Hash, Plus, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useSettings, type Paper } from '../../state/settings';
import { Popover } from '../../components/common/Popover';
import { cx, formatRelativeTime } from '../../lib/util';

export const PAPERS: { id: Paper; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'ruled', label: 'Ruled' },
  { id: 'legal', label: 'Ruled + margin' },
  { id: 'grid', label: 'Grid' },
  { id: 'dots', label: 'Dot grid' },
];

export function PaperSwatch({ paper }: { paper: Paper }) {
  return <span className={cx('paper-swatch', `paper-${paper}`)} />;
}

/**
 * Moves the caret from the title into the note body — synchronously, so fast
 * typing right after Enter never lands in the title. Enter opens a fresh first
 * line when the note already starts with content (like Notion).
 */
function focusBody(editor: Editor, newLine: boolean) {
  const first = editor.state.doc.firstChild;
  const firstIsEmptyText = first?.type.name === 'paragraph' && first.content.size === 0;
  let tr = editor.state.tr;
  if (newLine && first && !firstIsEmptyText) tr = tr.insert(0, editor.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

export function PageHeader({ note, editor }: { note: NoteDoc; editor: Editor }) {
  const updateMeta = useVault((s) => s.updateMeta);
  const focusTitle = useUI((s) => s.focusTitle);
  const defaultPaper = useSettings((s) => s.paper);
  const [title, setTitle] = useState(note.meta.title);
  const [tagInput, setTagInput] = useState<string | null>(null);
  const [paperOpen, setPaperOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const paperBtn = useRef<HTMLButtonElement>(null);
  const allTags = useVault((s) => {
    const set = new Set<string>();
    for (const n of Object.values(s.notes)) for (const t of n.meta.tags) set.add(t);
    return [...set].sort().join('\u0000');
  });

  useEffect(() => setTitle(note.meta.title), [note.meta.id, note.meta.title]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  useEffect(() => {
    if (focusTitle === note.meta.id) {
      requestAnimationFrame(() => titleRef.current?.focus());
      useUI.getState().set({ focusTitle: null });
    }
  }, [focusTitle, note.meta.id]);

  const commitTitle = () => {
    const t = title.replace(/\s+/g, ' ').trim();
    if (t !== note.meta.title) updateMeta(note.meta.id, { title: t });
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (tag && !note.meta.tags.includes(tag)) updateMeta(note.meta.id, { tags: [...note.meta.tags, tag] });
  };

  const paper = note.meta.paper ?? defaultPaper;
  const suggestions = tagInput
    ? allTags
        .split('\u0000')
        .filter((t) => t && t.startsWith(tagInput.toLowerCase().replace(/^#/, '')) && !note.meta.tags.includes(t))
        .slice(0, 5)
    : [];

  return (
    <header className="page-header" data-ui>
      <div className="page-crumbs">
        <button className="crumb" onClick={() => useUI.getState().setView(note.meta.folder ? { kind: 'folder', path: note.meta.folder } : { kind: 'home' })}>
          <Folder size={13} />
          {note.meta.folder ? note.meta.folder.split('/').join(' / ') : 'Notes'}
        </button>
        <span className="crumb-dot">·</span>
        <span className="crumb-muted">Edited {formatRelativeTime(note.meta.updated)}</span>
        <span className="grow" />
        <button ref={paperBtn} className="crumb crumb-paper" onClick={() => setPaperOpen((v) => !v)} title="Paper">
          <PaperSwatch paper={paper} />
          {PAPERS.find((p) => p.id === paper)?.label}
          <ChevronDown size={12} />
        </button>
      </div>
      <textarea
        ref={titleRef}
        className="page-title"
        value={title}
        rows={1}
        placeholder="Untitled"
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            commitTitle();
            focusBody(editor, e.key === 'Enter');
          }
        }}
      />
      <div className="page-tags">
        {note.meta.tags.map((t) => (
          <span key={t} className="tag-chip">
            <Hash size={11} />
            <button className="tag-chip-text" onClick={() => useUI.getState().setView({ kind: 'tag', tag: t })}>
              {t}
            </button>
            <button className="tag-chip-x" onClick={() => updateMeta(note.meta.id, { tags: note.meta.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        {tagInput === null ? (
          <button className="tag-add" onClick={() => setTagInput('')}>
            <Plus size={12} /> Tag
          </button>
        ) : (
          <span className="tag-input-wrap">
            <Hash size={11} />
            <input
              autoFocus
              className="tag-input"
              value={tagInput}
              placeholder="tag"
              onChange={(e) => setTagInput(e.target.value)}
              onBlur={() => {
                if (tagInput.trim()) addTag(tagInput);
                setTagInput(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag(tagInput);
                  setTagInput('');
                } else if (e.key === 'Escape') setTagInput(null);
                else if (e.key === 'Tab' && suggestions[0]) {
                  e.preventDefault();
                  addTag(suggestions[0]);
                  setTagInput('');
                }
              }}
            />
            {suggestions.length > 0 && (
              <span className="tag-suggest">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(s);
                      setTagInput('');
                    }}
                  >
                    #{s}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
      <Popover anchor={paperBtn.current} open={paperOpen} onClose={() => setPaperOpen(false)} align="end" className="menu-pop">
        <div className="menu paper-menu">
          {PAPERS.map((p) => (
            <button
              key={p.id}
              className={cx('menu-item', paper === p.id && 'is-checked')}
              onClick={() => {
                updateMeta(note.meta.id, { paper: p.id, updated: note.meta.updated });
                setPaperOpen(false);
              }}
            >
              <PaperSwatch paper={p.id} />
              <span className="menu-label">{p.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </header>
  );
}
