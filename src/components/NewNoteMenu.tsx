import { FileUp } from 'lucide-react';
import { Popover } from './common/Popover';
import { PaperTiles } from './PaperPicker';
import { useSettings } from '../state/settings';
import { newNote, newNoteFolder } from '../lib/commands';
import { importFiles } from '../lib/import';
import { normalizePaper } from '../lib/paper';

/** "In Biology", "In Lab reports", or "In Notes" for the top of the vault. */
export function placeCaption(folder: string) {
  return `In ${folder ? folder.split('/').pop() : 'Notes'}`;
}

/**
 * The New note menu: where the note will go, the three papers (one click makes the note), and Import.
 * Opened by the sidebar's New note and by a class page's New note button (which passes its class).
 */
export function NewNotePopover({
  anchor,
  open,
  onClose,
  folder,
  placement = 'right',
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  folder?: string;
  placement?: 'right' | 'bottom';
}) {
  const last = normalizePaper(useSettings((s) => s.paper));
  if (!open) return null;
  const where = folder ?? newNoteFolder();
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement={placement} align="start" className="menu-pop new-note-pop">
      <div className="menu" role="menu" aria-label="New note">
        <div className="menu-caption">{placeCaption(where)}</div>
        <PaperTiles
          last={last}
          onPick={(paper) => {
            onClose();
            newNote(where, { paper });
          }}
        />
        <div className="menu-sep" />
        <button
          className="menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            void importFiles(undefined, where);
          }}
        >
          <FileUp size={16} strokeWidth={1.5} />
          <span className="menu-label">Import PDF, Markdown or images…</span>
        </button>
      </div>
    </Popover>
  );
}
