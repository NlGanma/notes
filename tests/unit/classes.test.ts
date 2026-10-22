import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classForFolder, classInfo, classNotes, classHomework, guessClassIcon, homeworkFolderFor, listClasses } from '../../src/lib/classes';
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
