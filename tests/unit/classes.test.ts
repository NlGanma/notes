import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classCounts, classForFolder, classInfo, classNotes, classHomework, countLine, guessClassIcon, homeworkFolderFor, listClasses, settleClassName } from '../../src/lib/classes';
import { CLASSES, vault } from './fixtures';

test('a folder belongs to its nearest class ancestor', () => {
  assert.equal(classForFolder('Calculus I', CLASSES), 'Calculus I');
  assert.equal(classForFolder('Calculus I/Unit 2/Week 3', CLASSES), 'Calculus I');
  assert.equal(classForFolder('Drafts', CLASSES), null);
  assert.equal(classForFolder('', CLASSES), null);
});

test('classes are listed by name, archived ones hidden unless asked for', () => {
  const folders = ['Biology', 'Calculus I', 'Calculus I/Homework', 'Drafts', 'Old Class'];
  assert.deepEqual(
    listClasses(folders, CLASSES).map((c) => c.name),
    ['Biology', 'Calculus I'],
  );
  assert.deepEqual(
    listClasses(folders, CLASSES, { archived: true }).map((c) => c.name),
    ['Biology', 'Calculus I', 'Old Class'],
  );
});

test('class info fills in a colour and guesses an icon from the name', () => {
  const c = classInfo('Biology', CLASSES.Biology);
  assert.match(c.color, /^#/);
  assert.equal(c.icon, 'dna');
  assert.equal(classInfo('Calculus I', CLASSES['Calculus I']).code, 'MATH 1A');
  assert.equal(guessClassIcon('AP US History'), 'landmark');
  assert.equal(guessClassIcon('Intro to Programming'), 'code');
  assert.equal(guessClassIcon('Spanish 2'), 'languages');
  assert.equal(guessClassIcon('Underwater Basket Weaving'), 'cap');
});

test('a class name is settled without errors: blank is Untitled class, a taken name gets a number in any case', () => {
  const folders = ['Biology', 'Calculus I', 'Calculus I/Homework', 'Reading list', 'Untitled class'];
  assert.equal(settleClassName('', folders), 'Untitled class 2');
  assert.equal(settleClassName('  ...  ', folders), 'Untitled class 2');
  assert.equal(settleClassName('Chemistry', folders), 'Chemistry');
  assert.equal(settleClassName('biology', folders), 'biology 2');
  // A plain folder's name is taken too: the class gets its own folder.
  assert.equal(settleClassName('Reading List', folders), 'Reading List 2');
  // Subfolders don't clash with top-level names.
  assert.equal(settleClassName('Homework', folders), 'Homework');
  // Renaming a class may keep its own name or change only its case.
  assert.equal(settleClassName('Biology', folders, 'Biology'), 'Biology');
  assert.equal(settleClassName('BIOLOGY', folders, 'Biology'), 'BIOLOGY');
  assert.equal(settleClassName('Calculus i', folders, 'Biology'), 'Calculus i 2');
});

test('a class counts its notes and homework', () => {
  const v = vault();
  assert.deepEqual(classCounts('Calculus I', v.notes), { notes: 2, homework: 1 });
  assert.equal(countLine({ notes: 2, homework: 1 }), '2 notes · 1 homework');
  assert.equal(countLine({ notes: 1, homework: 0 }), '1 note');
  assert.equal(countLine({ notes: 0, homework: 3 }), '3 homework');
  assert.equal(countLine({ notes: 0, homework: 0 }), '');
});

test('homework lives in the class Homework folder', () => {
  assert.equal(homeworkFolderFor('Calculus I'), 'Calculus I/Homework');
  assert.equal(homeworkFolderFor(null), 'Homework');
});

test('class notes exclude homework and trash; homework is listed separately', () => {
  const v = vault();
  assert.deepEqual(
    classNotes('Calculus I', v.notes)
      .map((n) => n.meta.title)
      .sort(),
    ['Lecture 4 — Limits & Continuity', 'Lecture 5 — Derivatives'],
  );
  assert.deepEqual(
    classHomework('Calculus I', v.notes).map((n) => n.meta.title),
    ['Problem Set 4'],
  );
});

test('an unfiled note is matched to the class whose notes it resembles', async () => {
  const { suggestClass } = await import('../../src/lib/classes');
  const { note, p, h } = await import('./fixtures');
  const v = vault();
  const folders = ['Biology', 'Calculus I', 'Calculus I/Homework', 'Calculus I/Unit 2'];
  const loose = note('Untitled', '', [
    h('Review'),
    p('The squeeze theorem: if g ≤ f ≤ h and lim g = lim h = L then lim f = L. Continuity needs the limit to exist.'),
  ]);
  const s = suggestClass(loose, { ...v.notes, [loose.meta.id]: loose }, folders, CLASSES);
  assert.equal(s?.cls.name, 'Calculus I');
  // Already in a class, or nothing to go on: no suggestion.
  assert.equal(suggestClass(v.lecture4, v.notes, folders, CLASSES), null);
  assert.equal(suggestClass(v.loose, v.notes, folders, CLASSES), null);
});
