import { goBack, goForward, useUI } from '../state/ui';
import {
  closeCurrentTab,
  currentNoteId,
  newClass,
  newFolder,
  newHomework,
  newNote,
  openLibrary,
  openReview,
  openVaultFolder,
  redo,
  revealCurrent,
  toggleAssistant,
  undo,
  zoom,
} from './commands';
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
    case 'new-homework':
      newHomework();
      break;
    case 'new-class':
      newClass();
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
    case 'review':
      openReview();
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
      ui.openSettings();
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
    case 'back':
      goBack();
      break;
    case 'forward':
      goForward();
      break;
    // The window went in or out of full screen: the traffic lights come and go with it.
    case 'fullscreen':
      document.documentElement.classList.toggle('is-fullscreen', arg === 'on');
      break;
  }
}

/** A field that keeps its own undo: text inputs, and a contenteditable on screen (a hidden note's is not). */
function ownsUndo(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches('textarea, input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=color], [type=file])')) return true;
  return (el as HTMLElement).isContentEditable && !el.closest('.is-hidden');
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
    map['['] = () => runCommand('back');
    map[']'] = () => runCommand('forward');
    if (e.shiftKey) map['l'] = () => runCommand('library');
    if (e.shiftKey) map['y'] = () => runCommand('new-homework');
    if (e.shiftKey) map['e'] = () => runCommand('review');
    // Undo is the open note's (its text and ink share one history). Left to the browser, ⌘Z would undo typing
    // in whichever note was last edited, even one that isn't on screen.
    if (!e.altKey && !ownsUndo(document.activeElement)) {
      map['z'] = () => runCommand(e.shiftKey ? 'redo' : 'undo');
      if (!e.shiftKey) map['y'] = () => runCommand('redo');
    }
  }
  const fn = map[key];
  if (fn && !(key === 'l' && !e.shiftKey)) {
    e.preventDefault();
    fn();
  }
}
