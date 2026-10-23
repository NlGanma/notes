import { useState } from 'react';
import { ArrowLeft, ChevronRight, Code2, Copy, Download, FileDown, FileJson, FileType2, FolderInput, Minus, Plus, SpellCheck, Trash2, ZoomIn } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { normalizePaper, PAPERS, type Paper } from '../../lib/paper';
import { PaperPicker } from '../../components/PaperPicker';
import { PolishPanel } from '../../components/PolishPanel';
import { MOD } from '../../lib/platform';
import { HOMEWORK_SUBFOLDER, isClassFolder } from '../../lib/classes';
import { displayTitle } from '../../lib/displayTitle';
import { exportNote } from '../../lib/export';
import { pickFolder } from '../../components/common/dialogs';

export { PAPERS };

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/**
 * The note's ⋯ menu, the one home of what can be done to the note as a whole: its paper, Polish, Export,
 * Move, Duplicate, Zoom and Trash.
 */
export function MoreMenu({ note, onDone }: { note: NoteDoc; onDone(): void }) {
  const [sub, setSub] = useState<null | 'polish' | 'export'>(null);
  const zoom = useUI((s) => s.zoom);
  const id = note.meta.id;

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

  const setPaper = (p: Paper) => useVault.getState().updateMeta(id, { paper: p, updated: note.meta.updated });

  const moveTo = async () => {
    onDone();
    const choice = await pickFolder(`Move ${short(displayTitle(note))} to…`, note.meta.folder);
    if (choice === null) return;
    // Homework filed into a class goes into that class's Homework folder.
    const { folderMeta } = useVault.getState();
    const target = note.meta.homework && choice && isClassFolder(choice, folderMeta) ? `${choice}/${HOMEWORK_SUBFOLDER}` : choice;
    if (target !== note.meta.folder) useVault.getState().moveNote(id, target);
  };

  return (
    <div className="menu more-menu">
      <div className="more-paper">
        <span className="menu-caption">Paper</span>
        <PaperPicker value={normalizePaper(note.meta.paper)} onChange={setPaper} size="s" />
      </div>
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => setSub('polish')}>
        <SpellCheck size={16} />
        <span className="menu-label">Polish…</span>
      </button>
      <button className="menu-item" onClick={() => setSub('export')}>
        <Download size={16} />
        <span className="menu-label">Export</span>
        <ChevronRight size={14} className="menu-chev" />
      </button>
      <button className="menu-item" onClick={() => void moveTo()}>
        <FolderInput size={16} />
        <span className="menu-label">Move to…</span>
      </button>
      <button
        className="menu-item"
        onClick={() => {
          onDone();
          const copy = useVault.getState().duplicateNote(id);
          if (copy) useUI.getState().openNote(copy.meta.id, { newTab: true });
        }}
      >
        <Copy size={16} />
        <span className="menu-label">Duplicate</span>
      </button>
      <div className="more-zoom">
        <ZoomIn />
        <span className="menu-label">Zoom</span>
        <button className="icon-btn is-tiny" aria-label="Zoom out" title={`Zoom out  ${MOD}−`} onClick={() => useUI.getState().setZoom(zoom / 1.1)}>
          <Minus size={14} />
        </button>
        <button className="more-zoom-value" title={`Actual size  ${MOD}0`} onClick={() => useUI.getState().setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn is-tiny" aria-label="Zoom in" title={`Zoom in  ${MOD}+`} onClick={() => useUI.getState().setZoom(zoom * 1.1)}>
          <Plus size={14} />
        </button>
      </div>
      <div className="menu-sep" />
      <button
        className="menu-item is-danger"
        onClick={() => {
          onDone();
          useVault.getState().trashNote(id);
        }}
      >
        <Trash2 size={16} />
        <span className="menu-label">Move to Trash</span>
      </button>
    </div>
  );
}
