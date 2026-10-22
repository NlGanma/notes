import type { FolderMeta, NoteDoc } from './vault/types';
import { bm25Scores, buildBm25, chunkVault, tokenize } from './ai/rag';
import { docToText } from './ai/context';

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
 * Class themes, as Google Classroom does them: each is a coordinated set used
 * in fixed roles — the banner and card header, the main colour for icons and
 * filled buttons, the dark colour for small accent text, the light colour for
 * tonal backgrounds such as the letter avatar.
 */
export interface ClassTheme {
  key: string;
  label: string;
  banner: string;
  main: string;
  dark: string;
  light: string;
}

export const CLASS_THEMES: ClassTheme[] = [
  { key: 'blue', label: 'Blue', banner: '#4285f4', main: '#1967d2', dark: '#174ea6', light: '#e8f0fe' },
  { key: 'ocean', label: 'Ocean', banner: '#0277bd', main: '#1a73e8', dark: '#185abc', light: '#e8f0fe' },
  { key: 'green', label: 'Green', banner: '#33ac71', main: '#1e8e3e', dark: '#137333', light: '#e6f4ea' },
  { key: 'teal', label: 'Teal', banner: '#009688', main: '#129eaf', dark: '#007b83', light: '#e4f7fb' },
  { key: 'orange', label: 'Orange', banner: '#ff8a66', main: '#e8710a', dark: '#c26401', light: '#feefe3' },
  { key: 'pink', label: 'Pink', banner: '#d91a60', main: '#e52592', dark: '#b80672', light: '#fde7f3' },
  { key: 'purple', label: 'Purple', banner: '#863a95', main: '#9334e6', dark: '#7627bb', light: '#f3e8fd' },
  { key: 'slate', label: 'Slate', banner: '#566e7a', main: '#5f6368', dark: '#202124', light: '#f1f3f4' },
];

/** Colours older versions stored for classes, and the theme each now uses. */
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

/** The colour a new class is given (each theme's banner colour); the class page's Customize changes it. */
export const CLASS_COLORS = ['#4285f4', '#33ac71', '#ff8a66', '#863a95', '#009688', '#d91a60', '#0277bd', '#566e7a'];

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
