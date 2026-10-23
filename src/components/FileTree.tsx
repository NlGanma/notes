import {
  ClipboardCheck,
  ClipboardList,
  Copy,
  FilePlus,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GraduationCap,
  Pencil,
  Repeat,
  Settings2,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import type { MenuItem } from './common/ContextMenu';
import { confirmDialog, pickFolder, promptDialog } from './common/dialogs';
import { editClass, newFolder, newHomework, newNote, reviewFolder, reviewNote } from '../lib/commands';
import { isReviewable } from '../lib/review/tree';
import { classForFolder, HOMEWORK_SUBFOLDER, homeworkFolders, inFolder, moveTarget } from '../lib/classes';
import { displayTitle } from '../lib/displayTitle';
import type { NoteDoc } from '../lib/vault/types';
import { bridge } from '../lib/platform';
import { toast } from './common/toast';
import { sanitizeFolderName } from '../lib/util';

/*
 * The menus for a note, a folder and a class: the same items wherever they open (a row's ⋯, a
 * right-click, a tab, a class card). Note actions that belong to the open note (Export, Paper,
 * Polish) live in the editor's ⋯ menu instead.
 */

/** What to call a note (its title, else its first line or its date). */
export const noteTitle = (n: NoteDoc) => displayTitle(n);

/** Names in dialog titles and toasts stay short. */
export const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s);

const ICON = { size: 16, strokeWidth: 1.5 };

/** The menu for a class, a plain folder or a folder inside a class. */
export function folderMenu(path: string): MenuItem[] {
  const { folderMeta, notes: all, folders } = useVault.getState();
  const isClass = folderMeta[path]?.kind === 'class';
  const name = path.split('/').pop()!;
  const count = Object.values(all).filter((n) => !n.meta.trashed && (n.meta.folder === path || n.meta.folder.startsWith(path + '/'))).length;
  const reveal = bridge ? [{ label: 'Show in Finder', icon: <FolderOpen {...ICON} />, run: () => useVault.getState().backend?.revealFolder?.(path) }] : [];

  if (isClass) {
    return [
      { label: 'Edit class…', icon: <Settings2 {...ICON} />, run: () => editClass(path) },
      { label: 'New note', icon: <FilePlus {...ICON} />, run: () => newNote(path) },
      { label: 'New homework', icon: <ClipboardList {...ICON} />, run: () => newHomework(path) },
      ...(count ? [{ label: 'Review this class', icon: <Repeat {...ICON} />, run: () => reviewFolder(path) }] : []),
      ...reveal,
      { separator: true },
      {
        label: 'Delete class…',
        icon: <Trash2 {...ICON} />,
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: `Delete ${short(name)}?`,
            message: 'Its notes and homework move to Trash.',
            confirm: 'Delete class',
            danger: true,
          });
          if (ok) await deleteWithUndo(path, name);
        },
      },
    ];
  }

  const inClass = classForFolder(path, folderMeta);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return [
    { label: 'New note here', icon: <FilePlus {...ICON} />, run: () => newNote(path) },
    { label: 'New folder inside', icon: <FolderPlus {...ICON} />, run: () => void newFolder(path) },
    {
      label: 'Rename…',
      icon: <Pencil {...ICON} />,
      run: async () => {
        const v = await promptDialog({ title: 'Rename folder', label: 'Name', value: name, confirm: 'Rename' });
        if (!v || v === name || (await useVault.getState().renameFolder(path, v))) return;
        const clean = sanitizeFolderName(v);
        toast.error(clean ? `There is already a folder called “${short(clean)}”` : 'That name can’t be used for a folder');
      },
    },
    {
      label: 'Move to…',
      icon: <FolderInput {...ICON} />,
      run: async () => {
        // A folder can't go inside itself, and a class's folders stay in their class.
        const only = folders.filter((f) => f !== path && !f.startsWith(path + '/') && (!inClass || f === inClass || f.startsWith(inClass + '/')));
        const choice = await pickFolder(`Move ${short(name)} to…`, parent, inClass ? { only } : { exclude: [path] });
        if (choice !== null && choice !== parent) await useVault.getState().moveFolder(path, choice);
      },
    },
    ...(!path.includes('/') && !inClass
      ? [{ label: 'Make this a class', icon: <GraduationCap {...ICON} />, run: () => (useVault.getState().setIsClass(path, true), editClass(path)) }]
      : []),
    ...reveal,
    { separator: true },
    {
      label: 'Delete folder…',
      icon: <Trash2 {...ICON} />,
      danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: `Delete ${short(name)}?`,
          message: count === 1 ? 'Its note moves to Trash.' : count ? `Its ${count} notes move to Trash.` : 'There are no notes in it.',
          confirm: 'Delete folder',
          danger: true,
        });
        if (ok) await deleteWithUndo(path, name);
      },
    },
  ];
}

/** Deletes a class or folder, then offers Undo for a few seconds. */
async function deleteWithUndo(path: string, name: string) {
  // Undo is offered only once the folder is gone from disk, so restored notes never go to the Trash with it.
  const gone = await useVault.getState().deleteFolder(path);
  toast.info(`Deleted ${short(name)}`, undefined, { label: 'Undo', run: () => void useVault.getState().restoreFolder(gone) }, 8000);
}

/** The menu for a note (a row's ⋯, a right-click on a row or a tab). */
export function noteMenu(n: NoteDoc): MenuItem[] {
  const vault = useVault.getState();
  const name = displayTitle(n);
  return [
    { label: 'Open in new tab', icon: <SquareArrowOutUpRight {...ICON} />, run: () => useUI.getState().openNote(n.meta.id, { newTab: true }) },
    {
      label: 'Rename…',
      icon: <Pencil {...ICON} />,
      run: async () => {
        // Nothing is required: an empty name leaves the note untitled again.
        const v = await promptDialog({ title: 'Rename note', label: 'Name', value: n.meta.title, placeholder: name, confirm: 'Rename', allowEmpty: true });
        if (v !== null && v !== n.meta.title) useVault.getState().updateMeta(n.meta.id, { title: v });
      },
    },
    {
      label: 'Duplicate',
      icon: <Copy {...ICON} />,
      run: () => {
        const d = vault.duplicateNote(n.meta.id);
        if (d) useUI.getState().openNote(d.meta.id, { newTab: true });
      },
    },
    { label: 'Move to…', icon: <FolderInput {...ICON} />, run: () => moveNoteTo(n) },
    ...(isReviewable(n) ? [{ label: 'Review this note', icon: <Repeat {...ICON} />, run: () => reviewNote(n.meta.id) }] : []),
    n.meta.homework
      ? {
          label: n.meta.homework.done ? 'Mark not done' : 'Mark done',
          icon: <ClipboardCheck {...ICON} />,
          run: () => vault.updateMeta(n.meta.id, { homework: { ...n.meta.homework!, done: !n.meta.homework!.done } }),
        }
      : {
          label: 'Use as homework',
          icon: <ClipboardList {...ICON} />,
          run: () => {
            // e.g. a worksheet PDF that was imported as a plain note.
            const c = classForFolder(n.meta.folder, useVault.getState().folderMeta);
            vault.updateMeta(n.meta.id, { homework: { sources: [], folders: c ? [c] : [], due: undefined } });
            if (c) vault.moveNote(n.meta.id, `${c}/${HOMEWORK_SUBFOLDER}`);
          },
        },
    ...(bridge ? [{ label: 'Show in Finder', icon: <FolderOpen {...ICON} />, run: () => vault.backend?.reveal?.(n.meta.id) }] : []),
    { separator: true },
    { label: 'Move to Trash', icon: <Trash2 {...ICON} />, danger: true, run: () => trashNote(n.meta.id) },
  ];
}

/** Move to… for a note, from its row, its tab or the editor's ⋯ menu. */
export async function moveNoteTo(n: NoteDoc) {
  const { folderMeta } = useVault.getState();
  const hidden = homeworkFolders(folderMeta);
  // Homework sitting in its class's Homework folder shows as in the class.
  const current = hidden.some((h) => inFolder(n, h)) ? (classForFolder(n.meta.folder, folderMeta) ?? '') : n.meta.folder;
  const choice = await pickFolder(`Move ${short(displayTitle(n))} to…`, current, { exclude: hidden });
  if (choice === null) return;
  const target = moveTarget(n, choice, useVault.getState().folderMeta);
  if (target !== n.meta.folder) useVault.getState().moveNote(n.meta.id, target);
}

export function trashNote(id: string) {
  useVault.getState().trashNote(id);
  useUI.getState().closeTab(id);
}
