import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { classForFolder } from '../../lib/classes';
import { NotePicker } from './NotePicker';

/** Choose notes for an existing homework: which notes its answers may come from. */
export function LinkNotesDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'linkNotes';
  const hw = useVault((s) => (open ? s.notes[dialog.noteId] : undefined));
  const folderMeta = useVault((s) => s.folderMeta);
  if (!open || !hw?.meta.homework) return null;
  const close = () => useUI.getState().openDialog(null);
  return (
    <NotePicker
      open
      classPath={classForFolder(hw.meta.folder, folderMeta)}
      excludeId={hw.meta.id}
      initial={hw.meta.homework}
      query={hw}
      onClose={close}
      onInsert={(sel) => {
        // Read fresh: the homework may have changed while the dialog was open.
        const cur = useVault.getState().notes[hw.meta.id]?.meta.homework ?? hw.meta.homework!;
        useVault.getState().updateMeta(hw.meta.id, { homework: { ...cur, ...sel } });
        close();
      }}
    />
  );
}
