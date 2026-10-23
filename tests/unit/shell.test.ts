import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper, PAPERS } from '../../src/lib/paper';
import { dateTitle, displayTitle, isDateTitle } from '../../src/lib/displayTitle';
import { markerSizeFor, migrateSettings, migrateTools, migrateUI } from '../../src/state/migrate';
import { parseNoteFile, type NoteDoc } from '../../src/lib/vault/types';

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
  assert.deepEqual(migrateTools({ pen: { brush: 'marker', size: 2 } }, 1).pen, { brush: 'marker', size: 2 }, 'already current: untouched');
});

test('old default papers become one of the three', () => {
  assert.equal(migrateSettings({ paper: 'legal', font: 'serif' }, 0).paper, 'ruled');
  assert.equal(migrateSettings({ paper: 'dots' }, 0).paper, 'grid');
  assert.equal(migrateSettings({ paper: 'dots', font: 'serif' }, 0).font, 'serif');
  assert.ok(!('paper' in migrateSettings({}, 0)));
});
