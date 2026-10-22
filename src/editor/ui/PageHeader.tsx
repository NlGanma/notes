import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ClipboardList, Hash, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';
import { classForFolder, classInfo, HOMEWORK_SUBFOLDER, themeVars } from '../../lib/classes';
import { openContextMenu } from '../../components/common/ContextMenu';
import { HomeworkBar } from './HomeworkBar';

// The paper picker lives in the toolbar now; Settings still imports these from here.
export { PAPERS, PaperSwatch } from './PagePanels';

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

/** Apple Notes' date line: "Today at 2:14 PM", "Yesterday at 9:03 AM", else the full date. */
export function editedAt(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (ts >= midnight.getTime()) return `Today at ${time}`;
  if (ts >= midnight.getTime() - 86_400_000) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} at ${time}`;
}

/**
 * The top of the paper, as Apple Notes lays it out: a centred line with the class and the date, the title,
 * then hashtags as plain text. Nothing else lives inside the page.
 */
export function PageHeader({ note, editor }: { note: NoteDoc; editor: Editor }) {
  const updateMeta = useVault((s) => s.updateMeta);
  const focusTitle = useUI((s) => s.focusTitle);
  const [title, setTitle] = useState(note.meta.title);
  const [tagInput, setTagInput] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const folderMeta = useVault((s) => s.folderMeta);
  const classPath = classForFolder(note.meta.folder, folderMeta);
  const cls = classPath ? classInfo(classPath, folderMeta[classPath]) : null;
  const subPath = cls ? note.meta.folder.slice(cls.path.length + 1) : '';
  const allTags = useVault((s) => {
    const set = new Set<string>();
    for (const n of Object.values(s.notes)) for (const t of n.meta.tags) set.add(t);
    return [...set].sort().join('\u0000');
  });

  useEffect(() => setTitle(note.meta.title), [note.meta.id, note.meta.title]);

  // The title grows with its text. A note opened in a background tab has no size yet, so measure again once it shows.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => {
      if (!el.offsetWidth) return;
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
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
  const removeTag = (tag: string) => updateMeta(note.meta.id, { tags: note.meta.tags.filter((x) => x !== tag) });

  const suggestions = tagInput
    ? allTags
        .split('\u0000')
        .filter((t) => t && t.startsWith(tagInput.toLowerCase().replace(/^#/, '')) && !note.meta.tags.includes(t))
        .slice(0, 5)
    : [];

  const folderLabel = note.meta.folder ? note.meta.folder.split('/').join(' / ') : 'Notes';

  const tagsRow = (
    <div className={cx('page-tags', !note.meta.tags.length && tagInput === null && 'is-empty')}>
      {note.meta.tags.map((t) => (
        <button
          key={t}
          className="tag"
          onClick={() => useUI.getState().setView({ kind: 'tag', tag: t })}
          onContextMenu={(e) => openContextMenu(e, [{ label: 'Remove tag', icon: <X size={20} />, run: () => removeTag(t) }])}
          title="Click to see notes with this tag · right-click to remove"
        >
          #{t}
        </button>
      ))}
      {tagInput === null ? (
        <button className="tag-add" onClick={() => setTagInput('')}>
          + Add tag
        </button>
      ) : (
        <span className="tag-input-wrap">
          <Hash size={14} />
          <input
            autoFocus
            className="tag-input"
            value={tagInput}
            placeholder="tag"
            onChange={(e) => {
              setTagInput(e.target.value);
              setPick(0);
            }}
            onBlur={() => {
              if (tagInput.trim()) addTag(tagInput);
              setTagInput(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(e.key === 'Enter' && suggestions[pick] && tagInput.trim() ? suggestions[pick] : tagInput);
                setTagInput('');
              } else if (e.key === 'Escape') setTagInput(null);
              else if (e.key === 'Backspace' && !tagInput && note.meta.tags.length) {
                // Backspace at the start removes the last tag (Apple Notes / Notion).
                e.preventDefault();
                removeTag(note.meta.tags[note.meta.tags.length - 1]);
              } else if (e.key === 'ArrowDown' && suggestions.length) {
                e.preventDefault();
                setPick((p) => (p + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp' && suggestions.length) {
                e.preventDefault();
                setPick((p) => (p - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Tab' && suggestions[pick]) {
                e.preventDefault();
                addTag(suggestions[pick]);
                setTagInput('');
              }
            }}
          />
          {suggestions.length > 0 && (
            <span className="tag-suggest">
              {suggestions.map((s, i) => (
                <button
                  key={s}
                  className={cx(i === pick && 'is-active')}
                  onMouseEnter={() => setPick(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s);
                    setTagInput('');
                  }}
                >
                  <Hash size={16} />
                  {s}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  );

  const titleEl = (
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
  );

  return (
    <header
      className={cx('page-header', note.meta.homework && 'is-homework')}
      style={note.meta.homework && cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
      data-ui
    >
      {/* Homework shows its class, teacher and dates in its own Classroom-style meta line. */}
      {!note.meta.homework && (
        <div className="page-meta">
          {cls ? (
            <>
              <button className="crumb is-class" onClick={() => useUI.getState().setView({ kind: 'class', path: cls.path })} title={`Open ${cls.name}`}>
                {cls.name}
              </button>
              {subPath && subPath !== HOMEWORK_SUBFOLDER && (
                <>
                  <span className="crumb-sep">/</span>
                  <button className="crumb" onClick={() => useUI.getState().setView({ kind: 'folder', path: note.meta.folder })}>
                    {subPath.split('/').join(' / ')}
                  </button>
                </>
              )}
            </>
          ) : (
            <button
              className="crumb"
              onClick={() => useUI.getState().setView(note.meta.folder ? { kind: 'folder', path: note.meta.folder } : { kind: 'home' })}
            >
              {folderLabel}
            </button>
          )}
          <span className="crumb-dot" aria-hidden>
            ·
          </span>
          <span className="crumb-date">{editedAt(note.meta.updated)}</span>
        </div>
      )}
      {note.meta.homework ? (
        // Classroom's assignment page: the class-colour circle beside the title.
        <div className="hw-title-row">
          <span className="item-circle is-40">
            <ClipboardList size={24} />
          </span>
          {titleEl}
        </div>
      ) : (
        titleEl
      )}
      {note.meta.homework ? <HomeworkBar note={note} tags={tagsRow} /> : tagsRow}
    </header>
  );
}
