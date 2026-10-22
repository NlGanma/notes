import { useUI } from '../state/ui';
import { closeCurrentTab, currentNoteId, newFolder, newNote, openLibrary, openVaultFolder, redo, revealCurrent, toggleAssistant, undo, zoom } from './commands';
import { exportNote, type ExportKind } from './export';
import { importFiles } from './import';
import { isElectron } from './platform';

/** Runs a command coming from the native menu (or the keyboard in the browser). */
export function runCommand(cmd: string, arg?: string) {
  const ui = useUI.getState();
  switch (cmd) {
    case 'new-note':
      newNote();
      break;
    case 'new-folder':
      void newFolder();
      break;
    case 'palette':
      ui.setPalette(!ui.palette);
      break;
    case 'find':
      ui.setPalette(true);
      break;
    case 'library':
      openLibrary();
      break;
    case 'import':
      void importFiles();
      break;
    case 'export': {
      const id = currentNoteId();
      if (id) void exportNote(id, (arg as ExportKind) ?? 'pdf');
      break;
    }
    case 'close-tab':
      closeCurrentTab();
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
      redo();
      break;
    case 'toggle-sidebar':
      ui.toggleSidebar();
      break;
    case 'toggle-assistant':
      toggleAssistant();
      break;
    case 'zoom':
      zoom((arg as 'in' | 'out' | 'reset') ?? 'reset');
      break;
    case 'settings':
      ui.openSettings('ai');
      break;
    case 'shortcuts':
      ui.openSettings('shortcuts');
      break;
    case 'help-llm':
      ui.openSettings('ai');
      break;
    case 'open-vault':
      void openVaultFolder();
      break;
    case 'reveal':
      revealCurrent();
      break;
  }
}

/**
 * Keyboard shortcuts. In the Mac app the native menu owns most accelerators
 * (so they are skipped here); the browser build handles them all.
 */
export function handleGlobalKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  const menuOwned = isElectron;
  const map: Record<string, () => void> = {};
  if (!menuOwned) {
    map['n'] = () => runCommand(e.altKey ? 'new-folder' : 'new-note');
    map['k'] = () => runCommand('palette');
    map['j'] = () => runCommand('toggle-assistant');
    map['\\'] = () => runCommand('toggle-sidebar');
    map[','] = () => runCommand('settings');
    map['/'] = () => runCommand('shortcuts');
    map['p'] = () => runCommand('export', 'pdf');
    map['='] = () => runCommand('zoom', 'in');
    map['+'] = () => runCommand('zoom', 'in');
    map['-'] = () => runCommand('zoom', 'out');
    map['0'] = () => runCommand('zoom', 'reset');
    if (e.shiftKey) map['l'] = () => runCommand('library');
  }
  const fn = map[key];
  if (fn && !(key === 'l' && !e.shiftKey)) {
    e.preventDefault();
    fn();
  }
}
