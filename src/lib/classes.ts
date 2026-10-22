import type { FolderMeta, NoteDoc } from './vault/types';

/**
 * Classes are top-level folders flagged in the vault's folder metadata. On
 * disk a class is still just a folder of .nib files (Obsidian-compatible); the
 * metadata adds the course code, teacher, term, colour and icon, and every
 * feature — new notes, homework, Ask your notes, study tools — scopes to it.
 */

export interface ClassInfo {
  path: string;
  name: string;
  code?: string;
  instructor?: string;
  term?: string;
  color: string;
  icon: ClassIconName;
  archived: boolean;
}

export const HOMEWORK_SUBFOLDER = 'Homework';

export const CLASS_COLORS = ['#2160e8', '#7346e6', '#1f9d4c', '#e35d14', '#0f8073', '#d62f7a', '#c98a04', '#dc2b2b', '#1f3a8a', '#5b6472'];

export const CLASS_ICONS = [
  'sigma',
  'calculator',
  'atom',
  'flask',
  'dna',
  'landmark',
  'book',
  'languages',
  'code',
  'globe',
  'chart',
  'palette',
  'music',
  'brain',
  'scale',
  'cap',
] as const;
export type ClassIconName = (typeof CLASS_ICONS)[number];

const GUESSES: [RegExp, ClassIconName][] = [
  [/calc|math|algebra|geometry|trig|statistic|linear|discrete/i, 'sigma'],
  [/account|finance/i, 'calculator'],
  [/phys|mechanic|quantum|astro/i, 'atom'],
  [/chem|organic/i, 'flask'],
  [/bio|anatom|genetic|ecolog|physiol/i, 'dna'],
  [/hist|civics|government|politic/i, 'landmark'],
  [/engl|lit|writing|poetry|reading/i, 'book'],
  [/spanish|french|german|chinese|japanese|latin|language|korean|italian/i, 'languages'],
  [/comput|program|cs\b|software|data struct|algorithm/i, 'code'],
  [/geo(graph)?|earth|environment/i, 'globe'],
  [/econ|business|market/i, 'chart'],
  [/art|design|draw/i, 'palette'],
  [/music|band|choir/i, 'music'],
  [/psych|neuro|cognit/i, 'brain'],
  [/law|ethic|philos/i, 'scale'],
];

export function guessClassIcon(name: string): ClassIconName {
  return GUESSES.find(([re]) => re.test(name))?.[1] ?? 'cap';
}

export function isClassFolder(path: string, folderMeta: Record<string, FolderMeta>): boolean {
  return folderMeta[path]?.kind === 'class';
}

export function classInfo(path: string, meta: FolderMeta | undefined, i = 0): ClassInfo {
  const name = path.split('/').pop() || path;
  return {
    path,
    name,
    code: meta?.code || undefined,
    instructor: meta?.instructor || undefined,
    term: meta?.term || undefined,
    color: meta?.color || CLASS_COLORS[i % CLASS_COLORS.length],
    icon: (CLASS_ICONS as readonly string[]).includes(meta?.icon ?? '') ? (meta!.icon as ClassIconName) : guessClassIcon(name),
    archived: !!meta?.archived,
  };
}

export function listClasses(folders: string[], folderMeta: Record<string, FolderMeta>, opts: { archived?: boolean } = {}): ClassInfo[] {
  return folders
    .filter((f) => isClassFolder(f, folderMeta))
    .map((f, i) => classInfo(f, folderMeta[f], i))
    .filter((c) => opts.archived || !c.archived)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The class a folder belongs to (the folder itself or its nearest class ancestor), or null. */
export function classForFolder(folder: string, folderMeta: Record<string, FolderMeta>): string | null {
  if (!folder) return null;
  const parts = folder.split('/');
  for (let i = parts.length; i > 0; i--) {
    const p = parts.slice(0, i).join('/');
    if (isClassFolder(p, folderMeta)) return p;
  }
  return null;
}

export function classOfNote(note: NoteDoc | undefined | null, folderMeta: Record<string, FolderMeta>): string | null {
  return note ? classForFolder(note.meta.folder, folderMeta) : null;
}

export const inFolder = (n: NoteDoc, path: string) => n.meta.folder === path || n.meta.folder.startsWith(path + '/');

/** Lecture notes of a class (everything that is not homework). */
export function classNotes(path: string, notes: Record<string, NoteDoc>): NoteDoc[] {
  return Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && inFolder(n, path));
}

export function classHomework(path: string, notes: Record<string, NoteDoc>): NoteDoc[] {
  return Object.values(notes).filter((n) => !n.meta.trashed && !!n.meta.homework && inFolder(n, path));
}

/** Where new homework for a class is stored. */
export function homeworkFolderFor(classPath: string | null): string {
  return classPath ? `${classPath}/${HOMEWORK_SUBFOLDER}` : HOMEWORK_SUBFOLDER;
}

/** Short label for a class: its code if it has one, else its name. */
export function classLabel(c: Pick<ClassInfo, 'name' | 'code'>): string {
  return c.code || c.name;
}
