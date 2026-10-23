import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';
import { classForFolder, classInfo, HOMEWORK_SUBFOLDER } from '../../lib/classes';
import { HomeworkBar } from './HomeworkBar';
import { displayTitle, isDateTitle } from '../../lib/displayTitle';
import { PaperPicker } from '../../components/PaperPicker';
import { normalizePaper, type Paper } from '../../lib/paper';
import { useSettings } from '../../state/settings';

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

/** True while the body holds nothing at all: one empty line. */
function blankBody(editor: Editor) {
  const doc = editor.state.doc;
  return doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph' && doc.firstChild!.content.size === 0;
}

/**
 * A note made without picking a paper (⌘N, the palette, a menu's New note) offers the choice under its
 * title until something goes in the body: typing, a stroke, a paste or a drop. Then it fades but keeps its
 * room until the note is left, so a pen already writing never sees the page jump.
 */
function PaperStrip({ note, editor }: { note: NoteDoc; editor: Editor }) {
  const [spent, setSpent] = useState(() => !blankBody(editor));
  useEffect(() => {
    if (spent) return;
    const onUpdate = () => !blankBody(editor) && setSpent(true);
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [editor, spent]);
  // Picking here is a creation pick: the next note starts on it too.
  const pick = (paper: Paper) => {
    useVault.getState().updateMeta(note.meta.id, { paper, updated: note.meta.updated });
    useSettings.getState().set({ paper });
  };
  return (
    // Spent, it is visibility: hidden — out of the tab order and out of reach, but still holding its room.
    <div className={cx('paper-strip', spent && 'is-spent')}>
      <span className="paper-strip-label">Paper</span>
      <PaperPicker value={normalizePaper(note.meta.paper)} onChange={pick} size="s" className="is-strip" />
    </div>
  );
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
 * The top of the paper, as Apple Notes lays it out: a centred line with the class and the date, then the
 * title. Nothing else lives inside the page. (Tags are kept in the note's data for what they mark, e.g. the
 * guide, but are not shown or edited.)
 */
export function PageHeader({ note, editor }: { note: NoteDoc; editor: Editor }) {
  const updateMeta = useVault((s) => s.updateMeta);
  const focusTitle = useUI((s) => s.focusTitle);
  const strip = useUI((s) => s.paperStrip === note.meta.id);
  const [title, setTitle] = useState(note.meta.title);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const folderMeta = useVault((s) => s.folderMeta);
  const classPath = classForFolder(note.meta.folder, folderMeta);
  const cls = classPath ? classInfo(classPath, folderMeta[classPath]) : null;
  const subPath = cls ? note.meta.folder.slice(cls.path.length + 1) : '';
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

  const folderLabel = note.meta.folder ? note.meta.folder.split('/').join(' / ') : 'Notes';

  const titleEl = (
    <textarea
      ref={titleRef}
      className="page-title"
      value={title}
      rows={1}
      placeholder={isDateTitle(note) ? displayTitle(note) : 'Untitled'}
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
    // No is-homework class: a homework's header is any note's, without the old assignment-page title.
    <header className="page-header" data-ui>
      {/* Homework names its class in the row under its title (HomeworkBar), so its meta line is just the date. */}
      {note.meta.homework && (
        <div className="page-meta">
          <span className="crumb-date">{editedAt(note.meta.updated)}</span>
        </div>
      )}
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
      {titleEl}
      {strip && !note.meta.homework && <PaperStrip note={note} editor={editor} />}
      {note.meta.homework && <HomeworkBar note={note} />}
    </header>
  );
}
