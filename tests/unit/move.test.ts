import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeworkFolders, moveTarget } from '../../src/lib/classes';
import { CLASSES, note, p } from './fixtures';

test('Move to… hides every class’s Homework folder, archived classes included', () => {
  assert.deepEqual(homeworkFolders(CLASSES).sort(), ['Biology/Homework', 'Calculus I/Homework', 'Old Class/Homework']);
});

test('homework moved to a class goes into its Homework folder; a plain note goes where it was put', () => {
  const hw = note('Problem set 3', 'Biology/Homework', [p('1.')], { homework: { sources: [], folders: [] } });
  const plain = note('Lecture 6', 'Biology', [p('Notes')]);
  assert.equal(moveTarget(hw, 'Calculus I', CLASSES), 'Calculus I/Homework');
  assert.equal(moveTarget(hw, 'Calculus I/Unit 2', CLASSES), 'Calculus I/Unit 2');
  assert.equal(moveTarget(hw, 'Drafts', CLASSES), 'Drafts');
  assert.equal(moveTarget(hw, '', CLASSES), '');
  assert.equal(moveTarget(plain, 'Calculus I', CLASSES), 'Calculus I');
});
