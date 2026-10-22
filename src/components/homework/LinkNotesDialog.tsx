import { useEffect, useMemo, useState } from 'react';
import { Check, FileText, Search, Sparkles } from 'lucide-react';
import { Modal } from '../common/Modal';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { classForFolder, classInfo, inFolder } from '../../lib/classes';
import { homeworkSources, suggestSources } from '../../lib/homework';
import { ClassBadge } from '../classes/ClassIcon';
import { cx, plural } from '../../lib/util';
import type { NoteDoc } from '../../lib/vault/types';

const title = (n: NoteDoc) => n.meta.title || 'Untitled';

/** Choose exactly which notes a homework's answers may come from. */
export function LinkNotesDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'linkNotes';
  const noteId = open ? dialog.noteId : null;
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const hw = noteId ? notes[noteId] : null;
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open || !hw?.meta.homework) return;
    setSources(new Set(hw.meta.homework.sources));
    setFolders(new Set(hw.meta.homework.folders));
    setQ('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, noteId]);

  const classPath = hw ? classForFolder(hw.meta.folder, folderMeta) : null;
  const candidates = useMemo(() => Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && n.meta.id !== noteId), [notes, noteId]);
  const suggestions = useMemo(() => (hw ? suggestSources(hw, notes, 3, classPath) : []), [hw, notes, classPath]);

  // Group by top-level folder (its class, if it is one); the homework's own class first.
  const groups = useMemo(() => {
    const map = new Map<string, NoteDoc[]>();
    for (const n of candidates) {
      const top = n.meta.folder.split('/')[0] ?? '';
      const list = map.get(top) ?? [];
      list.push(n);
      map.set(top, list);
    }
    const ql = q.trim().toLowerCase();
    return [...map.entries()]
      .map(([top, list]) => ({
        top,
        cls: top && folderMeta[top]?.kind === 'class' ? classInfo(top, folderMeta[top]) : null,
        notes: list
          .filter((n) => !ql || title(n).toLowerCase().includes(ql) || n.meta.folder.toLowerCase().includes(ql))
          .sort((a, b) => title(a).localeCompare(title(b), undefined, { numeric: true })),
      }))
      .filter((g) => g.notes.length)
      .sort((a, b) => Number(b.top === classPath) - Number(a.top === classPath) || Number(!!b.cls) - Number(!!a.cls) || a.top.localeCompare(b.top));
  }, [candidates, folderMeta, q, classPath]);

  if (!open || !hw) return null;
  const close = () => useUI.getState().openDialog(null);

  const linkedFolder = (n: NoteDoc) => [...folders].find((f) => inFolder(n, f));
  const isOn = (n: NoteDoc) => sources.has(n.meta.id) || !!linkedFolder(n);

  const toggleNote = (n: NoteDoc) => {
    const f = linkedFolder(n);
    const s = new Set(sources);
    const fs = new Set(folders);
    if (f) {
      // Unlinking one note from a linked class: keep the others explicitly.
      fs.delete(f);
      for (const o of candidates) if (inFolder(o, f) && o.meta.id !== n.meta.id) s.add(o.meta.id);
    } else if (s.has(n.meta.id)) s.delete(n.meta.id);
    else s.add(n.meta.id);
    setSources(s);
    setFolders(fs);
  };

  const toggleGroup = (top: string, groupNotes: NoteDoc[]) => {
    const fs = new Set(folders);
    const s = new Set(sources);
    if (fs.has(top)) fs.delete(top);
    else {
      fs.add(top);
      for (const n of groupNotes) s.delete(n.meta.id);
    }
    setFolders(fs);
    setSources(s);
  };

  const preview = homeworkSources({ ...hw, meta: { ...hw.meta, homework: { ...hw.meta.homework!, sources: [...sources], folders: [...folders] } } }, notes);

  const save = () => {
    useVault.getState().updateMeta(hw.meta.id, { homework: { ...hw.meta.homework!, sources: [...sources], folders: [...folders] } });
    close();
  };

  return (
    <Modal open onClose={close} width={560} title={`Notes for “${title(hw)}”`} className="link-dialog">
      <div className="link-intro">
        The assistant answers this homework only from the notes you pick. Anything else it says is clearly marked as not from your notes.
      </div>
      <div className="link-search">
        <Search size={14} />
        <input autoFocus placeholder="Filter notes" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="link-body">
        {suggestions.length > 0 && !q && (
          <div className="link-group">
            <div className="link-group-head is-suggest">
              <Sparkles size={13} /> Suggested — they match this homework
            </div>
            {suggestions.map((s) => (
              <button key={s.note.meta.id} className={cx('link-row', isOn(s.note) && 'is-on')} onClick={() => toggleNote(s.note)}>
                <span className="link-check">{isOn(s.note) && <Check size={12} />}</span>
                <span className="link-title">{title(s.note)}</span>
                {s.terms.length > 0 && <span className="link-why">{s.terms.join(', ')}</span>}
              </button>
            ))}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.top || '~'} className="link-group">
            <button className={cx('link-group-head', folders.has(g.top) && 'is-on')} onClick={() => g.top && toggleGroup(g.top, g.notes)} disabled={!g.top}>
              {g.top && <span className="link-check">{folders.has(g.top) && <Check size={12} />}</span>}
              {g.cls ? <ClassBadge cls={g.cls} size={18} /> : null}
              <span className="link-group-name">{g.cls?.name ?? (g.top || 'Not in a class')}</span>
              {g.top && (
                <span className="link-group-all">{folders.has(g.top) ? 'All notes, including new ones' : `All ${plural(g.notes.length, 'note')}`}</span>
              )}
            </button>
            {g.notes.map((n) => (
              <button key={n.meta.id} className={cx('link-row is-nested', isOn(n) && 'is-on')} onClick={() => toggleNote(n)}>
                <span className="link-check">{isOn(n) && <Check size={12} />}</span>
                <FileText size={14} className="link-icon" />
                <span className="link-title">{title(n)}</span>
                {n.meta.folder.includes('/') && <span className="link-why">{n.meta.folder.split('/').slice(1).join(' / ')}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <span className="link-count">
          {preview.length ? `${plural(preview.length, 'note')} linked` : 'No notes linked — answers will be general knowledge only'}
        </span>
        <span className="grow" />
        <button className="btn is-ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn is-primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
