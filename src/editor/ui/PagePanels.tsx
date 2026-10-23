import { useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Code2, Copy, Download, FileDown, FileJson, FileType2, FolderInput, Minus, Plus, SpellCheck, Trash2, ZoomIn } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { normalizePaper, PAPERS, type Paper } from '../../lib/paper';
import { PaperPicker } from '../../components/PaperPicker';
import { PolishPanel } from '../../components/PolishPanel';
import { MOD } from '../../lib/platform';
import { HOMEWORK_SUBFOLDER, listClasses } from '../../lib/classes';
import { ClassBadge } from '../../components/classes/ClassIcon';
import { exportNote } from '../../lib/export';
import { newClass } from '../../lib/commands';

export { PAPERS };

/** The toolbar's Paper popover: the three papers. (Line spacing is for all notes, so it lives in Settings.) */
export function PaperPanel({ note }: { note: NoteDoc }) {
  const paper = normalizePaper(note.meta.paper);
  const setPaper = (p: Paper) => useVault.getState().updateMeta(note.meta.id, { paper: p, updated: note.meta.updated });
  return (
    <div className="paper-panel">
      <div className="pp-title">Paper</div>
      <PaperPicker value={paper} onChange={setPaper} size="m" />
    </div>
  );
}

/** ⋯ More: the note's own actions, in the order of Apple Notes' More menu. */
export function MoreMenu({ note, onDone }: { note: NoteDoc; onDone(): void }) {
  const [moving, setMoving] = useState(false);
  const [sub, setSub] = useState<null | 'polish' | 'export'>(null);
  const zoom = useUI((s) => s.zoom);
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const id = note.meta.id;

  if (moving) {
    const classes = listClasses(folders, folderMeta);
    const move = (folder: string) => {
      useVault.getState().moveNote(id, folder);
      onDone();
    };
    return (
      <div className="menu more-menu">
        <button className="menu-item" onClick={() => setMoving(false)}>
          <ArrowLeft size={20} />
          <span className="menu-label">Move to</span>
        </button>
        <div className="menu-sep" />
        {classes.map((c) => {
          const target = note.meta.homework ? `${c.path}/${HOMEWORK_SUBFOLDER}` : c.path;
          const here = note.meta.folder === target;
          return (
            <button key={c.path} className="menu-item" disabled={here} onClick={() => move(target)}>
              <ClassBadge cls={c} size={20} />
              <span className="menu-label">{c.name}</span>
              {here && <Check size={18} />}
            </button>
          );
        })}
        {classes.length > 0 && <div className="menu-sep" />}
        <button
          className="menu-item"
          onClick={() => {
            onDone();
            newClass();
          }}
        >
          <Plus size={20} />
          <span className="menu-label">New class…</span>
        </button>
      </div>
    );
  }

  if (sub === 'polish')
    return (
      <div className="menu polish-sheet">
        <PolishPanel noteId={id} onDone={onDone} />
      </div>
    );

  if (sub === 'export')
    return (
      <div className="menu more-menu">
        <button className="menu-item" onClick={() => setSub(null)}>
          <ArrowLeft size={16} />
          <span className="menu-label">Export</span>
        </button>
        <div className="menu-sep" />
        {(
          [
            ['pdf', 'PDF document', <FileDown size={16} key="i" />, `${MOD}P`],
            ['md', 'Markdown', <FileType2 size={16} key="i" />, ''],
            ['html', 'Web page (HTML)', <Code2 size={16} key="i" />, ''],
            ['nib', 'Nib note (.nib)', <FileJson size={16} key="i" />, ''],
          ] as const
        ).map(([kind, label, icon, hint]) => (
          <button
            key={kind}
            className="menu-item"
            onClick={() => {
              onDone();
              void exportNote(id, kind);
            }}
          >
            {icon}
            <span className="menu-label">{label}</span>
            {hint && <span className="menu-hint">{hint}</span>}
          </button>
        ))}
      </div>
    );

  return (
    <div className="menu more-menu">
      <button className="menu-item" onClick={() => setSub('polish')}>
        <SpellCheck size={20} />
        <span className="menu-label">Polish…</span>
      </button>
      <button className="menu-item" onClick={() => setSub('export')}>
        <Download size={20} />
        <span className="menu-label">Export</span>
        <ChevronRight size={16} />
      </button>
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => setMoving(true)}>
        <FolderInput size={20} />
        <span className="menu-label">Move to class</span>
      </button>
      <button
        className="menu-item"
        onClick={() => {
          onDone();
          const copy = useVault.getState().duplicateNote(id);
          if (copy) useUI.getState().openNote(copy.meta.id, { newTab: true });
        }}
      >
        <Copy size={20} />
        <span className="menu-label">Duplicate</span>
      </button>
      <div className="menu-item more-zoom">
        <ZoomIn size={20} />
        <span className="menu-label">Zoom</span>
        <button className="icon-btn is-tiny" aria-label="Zoom out" title={`Zoom out  ${MOD}−`} onClick={() => useUI.getState().setZoom(zoom / 1.1)}>
          <Minus size={18} />
        </button>
        <button className="more-zoom-value" title={`Actual size  ${MOD}0`} onClick={() => useUI.getState().setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn is-tiny" aria-label="Zoom in" title={`Zoom in  ${MOD}+`} onClick={() => useUI.getState().setZoom(zoom * 1.1)}>
          <Plus size={18} />
        </button>
      </div>
      <div className="menu-sep" />
      <button
        className="menu-item"
        onClick={() => {
          onDone();
          useVault.getState().trashNote(id);
        }}
      >
        <Trash2 size={20} />
        <span className="menu-label">Move to trash</span>
      </button>
    </div>
  );
}
