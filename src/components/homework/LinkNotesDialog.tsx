import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { classForFolder } from '../../lib/classes';
import { linkNotes } from '../../lib/commands';
import { NotePicker, type PickerTab } from './NotePicker';

const quoted = (t: string) => `Link notes to “${t || 'Untitled'}”`;

// The app's dialog state only carries the note id; "Whole class…" also says which tab to start on.
let nextTab: PickerTab | undefined;
export function openLinkPicker(noteId: string, tab?: PickerTab) {
  nextTab = tab;
  linkNotes(noteId);
}

/** Choose exactly which notes a homework's answers may come from (the Drive picker of Classroom). */
export function LinkNotesDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'linkNotes';
  const hw = useVault((s) => (open ? s.notes[dialog.noteId] : undefined));
  const folderMeta = useVault((s) => s.folderMeta);
  if (!open || !hw?.meta.homework) return null;
  const close = () => {
    nextTab = undefined;
    useUI.getState().openDialog(null);
  };
  return (
    <NotePicker
      open
      title={quoted(hw.meta.title)}
      classPath={classForFolder(hw.meta.folder, folderMeta)}
      excludeId={hw.meta.id}
      initial={hw.meta.homework}
      query={hw}
      initialTab={nextTab}
      onClose={close}
      onInsert={(sel) => {
        useVault.getState().updateMeta(hw.meta.id, { homework: { ...hw.meta.homework!, ...sel } });
        close();
      }}
    />
  );
}
