import { useState } from 'react';
import { ArrowLeft, Check, Copy, FolderInput, Minus, Plus, Printer, Trash2, ZoomIn } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useSettings, type LineSpacing, type Paper } from '../../state/settings';
import { cx } from '../../lib/util';
import { MOD } from '../../lib/platform';
import { HOMEWORK_SUBFOLDER, listClasses } from '../../lib/classes';
import { ClassBadge } from '../../components/classes/ClassIcon';
import { exportNote } from '../../lib/export';
import { newClass } from '../../lib/commands';

/** GoodNotes' template names. */
export const PAPERS: { id: Paper; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'ruled', label: 'Ruled' },
  { id: 'grid', label: 'Squared' },
  { id: 'dots', label: 'Dotted' },
  { id: 'legal', label: 'Legal pad' },
];

export function PaperSwatch({ paper }: { paper: Paper }) {
  return <span className={cx('paper-swatch', `paper-${paper}`)} />;
}

const SPACINGS: [LineSpacing, string][] = [
  ['compact', 'Compact'],
  ['comfortable', 'Comfortable'],
  ['roomy', 'Roomy'],
];

/** The toolbar's Paper popover: template thumbnails (GoodNotes), then line spacing and the default. */
export function PaperPanel({ note }: { note: NoteDoc }) {
  const settings = useSettings();
  const paper = note.meta.paper ?? settings.paper;
  const setPaper = (p: Paper) => useVault.getState().updateMeta(note.meta.id, { paper: p, updated: note.meta.updated });
  return (
    <div className="paper-panel">
      <div className="pp-title">Paper</div>
      <div className="pp-grid" role="radiogroup" aria-label="Paper">
        {PAPERS.map((p) => (
          <button key={p.id} role="radio" aria-checked={paper === p.id} className={cx('pp-item', paper === p.id && 'is-active')} onClick={() => setPaper(p.id)}>
            <span className={cx('pp-thumb', `paper-${p.id}`)} />
            <span className="pp-label">{p.label}</span>
          </button>
        ))}
      </div>
      <div className="pp-sep" />
      <div className="pp-title">
        Line spacing <span className="pp-sub">All notes</span>
      </div>
      <div className="seg pp-seg">
        {SPACINGS.map(([v, label]) => (
          <button key={v} className={cx(settings.lineSpacing === v && 'is-active')} onClick={() => settings.set({ lineSpacing: v })}>
            {label}
          </button>
        ))}
      </div>
      <label className="pp-default">
        <input type="checkbox" checked={settings.paper === paper} onChange={(e) => e.target.checked && settings.set({ paper })} />
        <span>Use {PAPERS.find((p) => p.id === paper)?.label.toLowerCase()} for new notes</span>
      </label>
    </div>
  );
}

/** ⋯ More: the note's own actions, in the order of Apple Notes' More menu. */
export function MoreMenu({ note, onDone }: { note: NoteDoc; onDone(): void }) {
  const [moving, setMoving] = useState(false);
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

  return (
    <div className="menu more-menu">
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
        <span className="menu-label">Make a copy</span>
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
          void exportNote(id, 'pdf');
        }}
      >
        <Printer size={20} />
        <span className="menu-label">Print</span>
        <span className="menu-hint">{MOD}P</span>
      </button>
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
