import type { FolderMeta, NoteDoc } from './vault/types';
import { bm25Scores, buildBm25, chunkVault, tokenize } from './ai/rag';
import { docToText } from './ai/context';
import { plural, sanitizeFolderName } from './util';

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
  /** The theme's main colour (icons, circles, buttons inside the class). */
  color: string;
  theme: ClassTheme;
  icon: ClassIconName;
  archived: boolean;
}

/**
 * Class colours: calm, slightly muted tones that keep white text readable on a card header. Each theme
 * is a coordinated set used in fixed roles: the header colour, the main colour for icons, dots and
 * checkboxes, the dark colour for small accent text, the light colour for tinted backgrounds.
 * The keys stay from older versions (stored colours map onto them); only the tones changed.
 */
export interface ClassTheme {
  key: string;
  label: string;
  banner: string;
  main: string;
  dark: string;
  light: string;
}

// Lowercase: themeFor matches stored colours after lowercasing them.
export const CLASS_THEMES: ClassTheme[] = [
  { key: 'blue', label: 'Sky', banner: '#3e6fa8', main: '#3e6fa8', dark: '#305783', light: '#e8eef5' },
  { key: 'ocean', label: 'Indigo', banner: '#4f5ba8', main: '#4f5ba8', dark: '#3e4783', light: '#eaebf5' },
  { key: 'green', label: 'Olive', banner: '#5e7a45', main: '#5e7a45', dark: '#495f36', light: '#ecefe9' },
  { key: 'teal', label: 'Teal', banner: '#2f7d7a', main: '#2f7d7a', dark: '#25625f', light: '#e6efef' },
  { key: 'orange', label: 'Ochre', banner: '#946a16', main: '#946a16', dark: '#735311', light: '#f2ede3' },
  { key: 'pink', label: 'Rose', banner: '#b44f6b', main: '#b44f6b', dark: '#8c3e53', light: '#f6eaed' },
  { key: 'purple', label: 'Plum', banner: '#7d5a9e', main: '#7d5a9e', dark: '#62467b', light: '#efebf3' },
  { key: 'slate', label: 'Slate', banner: '#5c5f66', main: '#5c5f66', dark: '#484a50', light: '#ebeced' },
];

/** Colours older versions stored for classes, and the theme each now uses. Stored colours are never rewritten. */
const LEGACY_THEME: Record<string, string> = {
  '#2160e8': 'blue',
  '#7346e6': 'purple',
  '#1f9d4c': 'green',
  '#e35d14': 'orange',
  '#0f8073': 'teal',
  '#d62f7a': 'pink',
  '#d6336c': 'pink',
  '#c98a04': 'orange',
  '#dc2b2b': 'pink',
  '#1f3a8a': 'ocean',
  '#5b6472': 'slate',
  // The Google Classroom themes of the previous design (banner, main and dark of each).
  '#4285f4': 'blue',
  '#1967d2': 'blue',
  '#174ea6': 'blue',
  '#0277bd': 'ocean',
  '#1a73e8': 'ocean',
  '#185abc': 'ocean',
  '#33ac71': 'green',
  '#1e8e3e': 'green',
  '#137333': 'green',
  '#009688': 'teal',
  '#129eaf': 'teal',
  '#007b83': 'teal',
  '#ff8a66': 'orange',
  '#e8710a': 'orange',
  '#c26401': 'orange',
  '#d91a60': 'pink',
  '#e52592': 'pink',
  '#b80672': 'pink',
  '#863a95': 'purple',
  '#9334e6': 'purple',
  '#7627bb': 'purple',
  '#566e7a': 'slate',
  '#5f6368': 'slate',
  '#202124': 'slate',
};

function hue(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return -1; // grey
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The theme for a stored class colour: an exact theme colour, a known older colour, or the nearest hue. */
export function themeFor(color: string | undefined, i = 0): ClassTheme {
  const c = (color ?? '').toLowerCase();
  if (!c) return CLASS_THEMES[i % CLASS_THEMES.length];
  const exact = CLASS_THEMES.find((t) => [t.banner, t.main, t.dark].includes(c) || t.key === c);
  if (exact) return exact;
  if (LEGACY_THEME[c]) return CLASS_THEMES.find((t) => t.key === LEGACY_THEME[c])!;
  const h = hue(c);
  if (h === null) return CLASS_THEMES[i % CLASS_THEMES.length];
  if (h < 0) return CLASS_THEMES.find((t) => t.key === 'slate')!;
  let best = CLASS_THEMES[0];
  let bestD = 999;
  for (const t of CLASS_THEMES) {
    const th = hue(t.banner);
    if (th === null || th < 0) continue;
    const d = Math.min(Math.abs(th - h), 360 - Math.abs(th - h));
    if (d < bestD) [best, bestD] = [t, d];
  }
  return best;
}

/** CSS custom properties that carry a class's theme into everything inside it. */
export function themeVars(t: ClassTheme): Record<string, string> {
  return { '--class': t.main, '--class-banner': t.banner, '--class-main': t.main, '--class-dark': t.dark, '--class-light': t.light };
}

export const HOMEWORK_SUBFOLDER = 'Homework';

/** The colour a new class is given, in turn (each theme's header colour). */
export const CLASS_COLORS = ['#3e6fa8', '#5e7a45', '#946a16', '#7d5a9e', '#2f7d7a', '#b44f6b', '#4f5ba8', '#5c5f66'];

/** A new class's colour: the first one no class has yet, so two classes never look alike until all eight are taken. */
export function freeClassColor(folders: string[], folderMeta: Record<string, FolderMeta>): string {
  const classes = listClasses(folders, folderMeta, { archived: true });
  const used = new Set(classes.map((c) => c.theme.key));
  return CLASS_COLORS.find((c) => !used.has(themeFor(c).key)) ?? CLASS_COLORS[classes.length % CLASS_COLORS.length];
}

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
    color: themeFor(meta?.color, i).main,
    theme: themeFor(meta?.color, i),
    icon: (CLASS_ICONS as readonly string[]).includes(meta?.icon ?? '') ? (meta!.icon as ClassIconName) : guessClassIcon(name),
    archived: !!meta?.archived,
  };
}

export function listClasses(folders: string[], folderMeta: Record<string, FolderMeta>, opts: { archived?: boolean } = {}): ClassInfo[] {
  return folders
    .filter((f) => !f.includes('/') && isClassFolder(f, folderMeta))
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
  const hwDir = `${path}/${HOMEWORK_SUBFOLDER}`;
  return Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && inFolder(n, path) && !inFolder(n, hwDir));
}

export function classHomework(path: string, notes: Record<string, NoteDoc>): NoteDoc[] {
  return Object.values(notes).filter((n) => !n.meta.trashed && !!n.meta.homework && inFolder(n, path));
}

/** How much a class holds: its notes (not homework) and its homework, done or not. */
export function classCounts(path: string, notes: Record<string, NoteDoc>): { notes: number; homework: number } {
  return { notes: classNotes(path, notes).length, homework: classHomework(path, notes).length };
}

/** "12 notes · 2 homework", leaving out what there is none of ('' for an empty class). */
export function countLine(c: { notes: number; homework: number }): string {
  return [c.notes ? plural(c.notes, 'note') : '', c.homework ? `${c.homework} homework` : ''].filter(Boolean).join(' · ');
}

/**
 * The name a class is saved under, so the dialog never has to show an error: a blank name becomes
 * "Untitled class", and a name another top-level folder already has (in any case, since the Mac's disk
 * ignores case) gets " 2", " 3"… `self` is the class being renamed, which may keep its own name.
 */
export function settleClassName(input: string, folders: string[], self?: string | null): string {
  const base = sanitizeFolderName(input) || 'Untitled class';
  const taken = new Set(folders.filter((f) => !f.includes('/') && f !== self).map((f) => f.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Where new homework for a class is stored. */
export function homeworkFolderFor(classPath: string | null): string {
  return classPath ? `${classPath}/${HOMEWORK_SUBFOLDER}` : HOMEWORK_SUBFOLDER;
}

/** Short label for a class: its code if it has one, else its name. */
export function classLabel(c: Pick<ClassInfo, 'name' | 'code'>): string {
  return c.code || c.name;
}

export interface ClassSuggestion {
  cls: ClassInfo;
  /** Words the note shares with that class's notes — shown as the reason. */
  terms: string[];
}

/**
 * Which class an unfiled note probably belongs to: the class whose notes
 * best match it (BM25 over their sections), when it clearly beats the rest.
 */
export function suggestClass(note: NoteDoc, notes: Record<string, NoteDoc>, folders: string[], folderMeta: Record<string, FolderMeta>): ClassSuggestion | null {
  if (classForFolder(note.meta.folder, folderMeta) || note.meta.tags.includes('guide')) return null;
  const classes = listClasses(folders, folderMeta);
  if (!classes.length) return null;
  const text = docToText(note.content);
  const qTokens = [...new Set(tokenize(`${note.meta.title} ${text}`))].filter((t) => t.length > 2);
  if (qTokens.length < 4) return null;
  const query = qTokens.slice(0, 120).join(' ');
  const chunks = classes.flatMap((c) => chunkVault(classNotes(c.path, notes).filter((n) => n.meta.id !== note.meta.id)));
  if (!chunks.length) return null;
  const scores = bm25Scores(buildBm25(chunks), query);
  const perClass = new Map<string, number[]>();
  chunks.forEach((ch, i) => {
    const cls = classForFolder(ch.folder, folderMeta)!;
    perClass.set(cls, [...(perClass.get(cls) ?? []), scores[i]]);
  });
  // A class's score: its three best matching sections.
  const ranked = [...perClass.entries()]
    .map(([path, s]) => ({
      path,
      score: s
        .sort((a, b) => b - a)
        .slice(0, 3)
        .reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best || best.score < 3 || (second && best.score < second.score * 1.6)) return null;
  const cls = classes.find((c) => c.path === best.path)!;
  const classTokens = new Set(chunks.filter((c) => classForFolder(c.folder, folderMeta) === best.path).flatMap((c) => tokenize(`${c.section} ${c.text}`)));
  return { cls, terms: qTokens.filter((t) => classTokens.has(t) && t.length > 3).slice(0, 4) };
}

/**
 * Move to… doesn't list the classes' Homework folders: homework gets there by picking its class, and a plain
 * note filed there would drop out of the class page.
 */
export function homeworkFolders(folderMeta: Record<string, FolderMeta>): string[] {
  return Object.keys(folderMeta)
    .filter((f) => !f.includes('/') && isClassFolder(f, folderMeta))
    .map((f) => homeworkFolderFor(f));
}

/** Where Move to… puts a note: homework filed into a class goes into that class's Homework folder. */
export function moveTarget(note: NoteDoc, choice: string, folderMeta: Record<string, FolderMeta>): string {
  return note.meta.homework && choice && isClassFolder(choice, folderMeta) ? homeworkFolderFor(choice) : choice;
}
