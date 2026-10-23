import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper, PAPERS } from '../../src/lib/paper';
import { dateTitle, displayTitle, isDateTitle } from '../../src/lib/displayTitle';
import { clockTime, tabLabels } from '../../src/lib/tabLabels';
import { markerSizeFor, migrateSettings, migrateTools, migrateUI, settleTools } from '../../src/state/migrate';
import { parseNoteFile, type NoteDoc } from '../../src/lib/vault/types';
import { savedUI, useUI } from '../../src/state/ui';

/** Paper, untitled-note names and the stored-state migrations behind the redesigned shell. */

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10).getTime();

function note(content: NoteDoc['content'], meta: Partial<NoteDoc['meta']> = {}): NoteDoc {
  return { version: 1, meta: { id: 'n1', title: '', folder: '', tags: [], created: at(2026, 10, 22), updated: at(2026, 10, 22), paper: 'ruled', ...meta }, content };
}
const para = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

test('there are exactly three papers, in picker order', () => {
  assert.deepEqual(
    PAPERS.map((p) => p.label),
    ['Blank', 'Squared', 'Lined'],
  );
});

test('old and unknown papers open as one of the three', () => {
  assert.equal(normalizePaper('legal'), 'ruled');
  assert.equal(normalizePaper('dots'), 'grid');
  assert.equal(normalizePaper('grid'), 'grid');
  assert.equal(normalizePaper('blank'), 'blank');
  assert.equal(normalizePaper(undefined), 'ruled');
  assert.equal(normalizePaper('papyrus'), 'ruled');
  assert.equal(normalizePaper(42), 'ruled');
});

test('every note read from a file has a paper', () => {
  const read = (paper?: string) => parseNoteFile(JSON.stringify({ meta: { id: 'a', title: 'x', paper }, content: { type: 'doc', content: [] } }))!.meta.paper;
  assert.equal(read('dots'), 'grid');
  assert.equal(read('legal'), 'ruled');
  assert.equal(read('blank'), 'blank');
  assert.equal(read(undefined), 'ruled');
});

test('a titled note goes by its title', () => {
  assert.equal(displayTitle(note({ type: 'doc', content: [para('Something else')] }, { title: 'Lecture 4' })), 'Lecture 4');
});

test('an untitled note goes by its first typed line, cut at a word', () => {
  assert.equal(displayTitle(note({ type: 'doc', content: [para(''), para('  Photosynthesis basics  '), para('second')] })), 'Photosynthesis basics');
  const long = 'The mitochondria is the powerhouse of the cell and also does many other remarkable things';
  const name = displayTitle(note({ type: 'doc', content: [para(long)] }));
  assert.ok(name.endsWith('…') && name.length <= 61, name);
  assert.ok(long.startsWith(name.slice(0, -1)), 'cut at a word boundary');
  assert.equal(displayTitle(note({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [para('in a list')] }] }] })), 'in a list');
});

test('with nothing typed, the handwriting names the note', () => {
  const ink = { type: 'inkBlock', attrs: { strokes: [], transcript: { text: 'lim x→0 sin x / x\nmore' } } };
  assert.equal(displayTitle(note({ type: 'doc', content: [ink, para('')] })), 'lim x→0 sin x / x');
});

test('an empty note goes by its date, homework by when it is due', () => {
  const empty = note({ type: 'doc', content: [para('')] });
  assert.equal(displayTitle(empty), 'Note · Oct 22');
  assert.ok(isDateTitle(empty));
  const due = note({ type: 'doc', content: [para(''), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My work' }] }] }, {
    homework: { sources: [], folders: [], due: at(2026, 10, 24) },
  });
  assert.equal(displayTitle(due), 'Homework · due Sat, Oct 24', 'the homework template heading is not a name');
  assert.equal(dateTitle(note({ type: 'doc', content: [] }, { homework: { sources: [], folders: [] } })), 'Homework · Oct 22');
  assert.ok(!isDateTitle(note({ type: 'doc', content: [para('typed')] })));
});

test('tabs with the same name are told apart by the time, the part that differs first', () => {
  const t = (h: number, m: number) => new Date(2026, 9, 23, h, m, 5).getTime();
  const blank = (id: string, created: number, meta: Partial<NoteDoc['meta']> = {}) => note({ type: 'doc', content: [para('')] }, { id, created, ...meta });
  const typed = (id: string, created: number) => note({ type: 'doc', content: [para('Limits')] }, { id, created });
  const hw = (id: string, created: number) => blank(id, created, { homework: { sources: [], folders: [], due: at(2026, 10, 24) } });
  const tabs = tabLabels([
    note({ type: 'doc', content: [] }, { id: 'w', title: 'Welcome to Nib' }),
    blank('c', t(12, 52) + 2),
    blank('a', t(12, 52)),
    blank('b', t(12, 52) + 1),
    blank('d', t(13, 5)),
    typed('e', t(9, 0)),
    typed('f', t(21, 7)),
    hw('g', t(8, 30)),
    hw('h', t(8, 31)),
  ]);
  const label = (id: string) => tabs.get(id)!.label;
  assert.equal(label('w'), 'Welcome to Nib');
  // The shared date gives way to the time; the same minute counts up by creation order.
  assert.deepEqual(['a', 'b', 'c', 'd'].map(label), ['12:52 PM', '12:52 PM 2', '12:52 PM 3', '1:05 PM']);
  assert.equal(tabs.get('b')!.full, 'Note · Oct 23, 12:52 PM 2', 'the tooltip keeps the whole name');
  assert.deepEqual(['e', 'f'].map(label), ['Limits, 9:00 AM', 'Limits, 9:07 PM']);
  assert.equal(label('g'), 'Homework · due Sat, Oct 24, 8:30 AM', 'a due date is kept');
  assert.equal(clockTime(new Date(2026, 9, 23, 0, 4).getTime()), '12:04 AM');
  // A lone untitled note keeps its plain name.
  assert.equal(tabLabels([blank('a', t(12, 52))]).get('a')!.label, 'Note · Oct 23');
});

test('the name is never stored', () => {
  const n = note({ type: 'doc', content: [para('Typed first line')] });
  displayTitle(n);
  assert.equal(n.meta.title, '');
});

test('saved pages that no longer exist open somewhere sensible', () => {
  const ui = (view: unknown, extra = {}) => migrateUI({ view, tabs: ['a'], ...extra }, 0);
  assert.deepEqual(ui({ kind: 'tag', tag: 'calculus' }).view, { kind: 'home' });
  assert.deepEqual(ui({ kind: 'favorites' }).view, { kind: 'home' });
  assert.deepEqual(ui({ kind: 'recent' }).view, { kind: 'home' });
  assert.deepEqual(ui({ kind: 'classes', archived: true }).view, { kind: 'classes' });
  assert.deepEqual(ui({ kind: 'class', path: 'Biology', tab: 'stream' }).view, { kind: 'class', path: 'Biology' });
  assert.deepEqual(ui({ kind: 'homework', filter: 'missing' }).view, { kind: 'homework' });
  assert.deepEqual(ui({ kind: 'nonsense' }).view, { kind: 'classes' });
  assert.deepEqual(ui(undefined).view, { kind: 'classes' });
  assert.deepEqual(ui({ kind: 'note', id: 'n1' }).view, { kind: 'note', id: 'n1' });
  const s = ui({ kind: 'home' }, { libraryScope: { kind: 'tag', tag: 'x' }, gridMode: 'list' });
  assert.deepEqual(s.libraryScope, { kind: 'all' });
  assert.ok(!('gridMode' in s));
  assert.deepEqual(s.tabs, ['a'], 'everything else is kept');
  assert.deepEqual(migrateUI({ libraryScope: { kind: 'folder', path: 'Biology' } }, 0).libraryScope, { kind: 'folder', path: 'Biology' });
});

test('a sidebar folded to the old icon rail opens shown, since there is no rail any more', () => {
  assert.equal(migrateUI({ sidebar: false, view: { kind: 'home' } }, 0).sidebar, true);
  assert.equal(migrateUI({ sidebar: true }, 0).sidebar, true);
  assert.equal(migrateUI({ sidebar: false }, 1).sidebar, false, 'hidden by hand in this version: kept');
});

test('old pens become the felt marker at the width they drew', () => {
  assert.equal(markerSizeFor(2.2, 'fountain'), 1.6, 'the old default stays medium');
  assert.equal(markerSizeFor(1.4, 'ballpoint'), 1.1);
  assert.equal(markerSizeFor(3.6, 'brush'), 2.5);
  assert.equal(markerSizeFor(2.5, 'marker'), 2.5);
  const t = migrateTools(
    {
      pen: { brush: 'fountain', color: '#2160e8', size: 2.2 },
      penSizes: [1.4, 2.2, 3.6],
      shape: { kind: 'rect' },
      lastInkTool: 'shapes',
      eraser: { mode: 'stroke', size: 18, highlighterOnly: true },
    },
    0,
  );
  assert.deepEqual(t.pen, { brush: 'marker', color: '#2160e8', size: 1.6 });
  assert.deepEqual(t.penSizes, [1.1, 1.6, 2.5]);
  assert.ok(!('shape' in t));
  assert.equal(t.lastInkTool, 'pen');
  assert.equal((t.eraser as { highlighterOnly: boolean }).highlighterOnly, true, 'the eraser option is kept');
  assert.equal(migrateTools({ lastInkTool: 'ask' }, 0).lastInkTool, 'lasso');
  assert.deepEqual(migrateTools({ highlighter: { color: '#ffe14d', size: 20 } }, 0).highlighterSizes, [10, 20, 24], 'a free highlighter size becomes the nearest slot');
  assert.deepEqual(migrateTools({ highlighter: { color: '#ffe14d', size: 16 } }, 0).highlighterSizes, [10, 16, 24]);
  assert.ok(!('highlighterSizes' in migrateTools({}, 0)), 'nothing saved: the defaults stand');
  assert.deepEqual(migrateTools({ pen: { brush: 'marker', size: 2 } }, 1).pen, { brush: 'marker', size: 2 }, 'already current: untouched');
});

test('a Shapes or Ask tool saved after the update is settled on every load, not only on a version change', () => {
  // nib.tools runs this from its persist merge, which zustand calls on every load.
  assert.equal(settleTools({ lastInkTool: 'shapes', penSizes: [1, 2, 3] }).lastInkTool, 'pen');
  assert.deepEqual(settleTools({ lastInkTool: 'shapes', penSizes: [1, 2, 3] }).penSizes, [1, 2, 3]);
  assert.equal(settleTools({ lastInkTool: 'ask' }).lastInkTool, 'lasso');
  assert.equal(settleTools({ lastInkTool: 'highlighter' }).lastInkTool, 'highlighter');
  assert.deepEqual(settleTools(null), {});
});

test('old default papers become one of the three', () => {
  assert.equal(migrateSettings({ paper: 'legal', font: 'serif' }, 0).paper, 'ruled');
  assert.equal(migrateSettings({ paper: 'dots' }, 0).paper, 'grid');
  assert.equal(migrateSettings({ paper: 'dots', font: 'serif' }, 0).font, 'serif');
  assert.ok(!('paper' in migrateSettings({}, 0)));
});

test('a closed tab goes back where it was, without taking the page', () => {
  const ui = useUI.getState();
  useUI.setState({ tabs: ['a', 'b', 'c'], view: { kind: 'home' } });
  ui.closeTab('b');
  assert.deepEqual(useUI.getState().tabs, ['a', 'c']);
  ui.reopenTab('b', 1);
  assert.deepEqual(useUI.getState().tabs, ['a', 'b', 'c']);
  assert.deepEqual(useUI.getState().view, { kind: 'home' });
  ui.reopenTab('b', 0);
  assert.deepEqual(useUI.getState().tabs, ['a', 'b', 'c'], 'a tab that is open stays where it is');
  useUI.setState({ tabs: [] });
});

test('a sidebar put away for the window is saved as shown; one hidden by hand stays hidden', () => {
  const saved = (p: { sidebar: boolean; sidebarAuto: boolean }) => savedUI({ ...useUI.getState(), ...p }).sidebar;
  assert.equal(saved({ sidebar: false, sidebarAuto: true }), true, 'a narrow window or the assistant hid it');
  assert.equal(saved({ sidebar: false, sidebarAuto: false }), false);
  assert.equal(saved({ sidebar: true, sidebarAuto: false }), true);

  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  const at = (narrow: boolean) => (g.window = { matchMedia: () => ({ matches: narrow }) });
  try {
    // Shown or hidden by hand beside the assistant: a choice, so closing the assistant leaves it.
    at(false);
    useUI.setState({ sidebar: false, sidebarAuto: true });
    useUI.getState().toggleSidebar();
    assert.deepEqual([useUI.getState().sidebar, useUI.getState().sidebarAuto], [true, false]);
    // Over a narrow window it only floats: widening still brings back the sidebar the user had.
    at(true);
    useUI.setState({ sidebar: false, sidebarAuto: true });
    useUI.getState().toggleSidebar();
    assert.deepEqual([useUI.getState().sidebar, useUI.getState().sidebarAuto], [true, true]);
  } finally {
    if (had) g.window = prev;
    else delete g.window;
    useUI.setState({ sidebar: true, sidebarAuto: false });
  }
});

test('a row preview reads math as text and keeps headings apart from the sentences around them', async () => {
  const { noteSnippet, plainMath } = await import('../../src/components/NoteGrid');
  assert.equal(plainMath('\\lim_{x \\to a} f(x) = L'), 'lim x → a f(x) = L');
  assert.equal(plainMath('\\frac{x^2-9}{x-3}'), '(x²-9)/(x-3)');
  assert.equal(plainMath('|f(x) - L| < \\varepsilon'), '|f(x) - L| < ε');
  const n = note({
    type: 'doc',
    content: [
      para('Prof. Alvarez · Tuesday'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Definition of a limit' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'We write ' }, { type: 'mathInline', attrs: { latex: '\\lim_{x \\to a} f(x) = L' } }, { type: 'text', text: ' when f(x) gets close to L.' }] },
    ],
  }, { title: 'Lecture 4' });
  assert.equal(noteSnippet(n), 'Prof. Alvarez · Tuesday · Definition of a limit · We write lim x → a f(x) = L when f(x) gets close to L.');
});
