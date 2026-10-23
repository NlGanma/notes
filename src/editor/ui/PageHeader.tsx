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
 * The top of the paper, as Apple Notes lays it out: a quiet line with where the note lives and when it was
 * edited, then the title in the serif. A homework note's line is only the time: its class is in the bar under
 * the title. (Tags stay in the note's data for what they mark, e.g. the guide, but are not shown.)
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

  const go = (path: string) => () => useUI.getState().setView({ kind: 'folder', path });
  // Where it lives: class › subfolder, a plain folder (each part a link), or nothing for a loose note.
  const crumbs: { label: string; onClick(): void; cls?: boolean }[] = [];
  if (!note.meta.homework) {
    if (cls) {
      crumbs.push({ label: cls.name, onClick: () => useUI.getState().setView({ kind: 'class', path: cls.path }), cls: true });
      if (subPath && subPath !== HOMEWORK_SUBFOLDER) {
        let at = cls.path;
        for (const part of subPath.split('/')) {
          at = `${at}/${part}`;
          crumbs.push({ label: part, onClick: go(at) });
        }
      }
    } else if (note.meta.folder) {
      let at = '';
      for (const part of note.meta.folder.split('/')) {
        at = at ? `${at}/${part}` : part;
        crumbs.push({ label: part, onClick: go(at) });
      }
    }
  }

  return (
    <header className={cx('page-header', note.meta.homework && 'is-homework')} data-ui>
      <div className="page-meta">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb-part">
            {i > 0 && (
              <span className="crumb-sep" aria-hidden>
                ›
              </span>
            )}
            <button className={cx('crumb', c.cls && 'is-class')} onClick={c.onClick} title={c.label}>
              {c.label}
            </button>
          </span>
        ))}
        {crumbs.length > 0 && (
          <span className="crumb-dot" aria-hidden>
            ·
          </span>
        )}
        <span className="crumb-date">{editedAt(note.meta.updated)}</span>
      </div>
      <textarea
        ref={titleRef}
        className="page-title"
        value={title}
        rows={1}
        placeholder={isDateTitle(note) ? displayTitle(note) : 'Untitled'}
        spellCheck={false}
        aria-label="Title"
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
      {strip && !note.meta.homework && <PaperStrip note={note} editor={editor} />}
      {note.meta.homework && <HomeworkBar note={note} />}
    </header>
  );
}
