import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey } from '../../src/components/review/sessionKeys';
import type { Item } from '../../src/lib/review/items';

/** Keys during a review session act only when they're meant for it. */

const key = (k: string, o: Partial<Parameters<typeof sessionKey>[0]> = {}) => ({
  key: k,
  defaultPrevented: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});
const body = { inSession: true, editable: false, control: false, overlay: false };
const at = (format: Item['format'], phase: 'ask' | 'feedback' | 'self' = 'ask') => ({ phase, item: { format, choices: ['a', 'b', 'c'] } as Item });

test('Esc ends the session — unless it closed a palette or a menu, or was pressed in another panel', () => {
  assert.deepEqual(sessionKey(key('Escape'), body, at('cloze')), { do: 'end' });
  assert.deepEqual(sessionKey(key('Escape'), { ...body, editable: true }, at('cloze')), { do: 'end' }, 'from the answer box too');
  assert.equal(sessionKey(key('Escape', { defaultPrevented: true }), body, at('cloze')), null, 'the palette closed with it');
  assert.equal(sessionKey(key('Escape'), { ...body, overlay: true }, at('cloze')), null, 'a dialog, the palette or a menu is open');
  assert.equal(sessionKey(key('Escape'), { ...body, inSession: false }, at('cloze')), null, 'typed in the assistant panel');
  assert.equal(sessionKey(key('Escape', { isComposing: true }), body, at('cloze')), null, 'cancelling an input method’s candidate');
});

test('Enter moves on from feedback, and shows the notes for a self-check — not when a button or field has it', () => {
  assert.deepEqual(sessionKey(key('Enter'), body, at('cloze', 'feedback')), { do: 'next' });
  assert.deepEqual(sessionKey(key('Enter'), body, at('rate')), { do: 'show' });
  assert.equal(sessionKey(key('Enter'), { ...body, control: true }, at('cloze', 'feedback')), null, 'a focused button (a dialog’s, or “I was right”) gets its own Enter');
  assert.equal(sessionKey(key('Enter'), { ...body, editable: true }, at('cloze', 'feedback')), null);
  assert.equal(sessionKey(key('Enter'), { ...body, overlay: true }, at('cloze', 'feedback')), null);
  assert.equal(sessionKey(key('Enter', { metaKey: true }), body, at('cloze', 'feedback')), null, 'a shortcut');
  assert.equal(sessionKey(key('Enter', { shiftKey: true }), body, at('cloze', 'feedback')), null);
  assert.equal(sessionKey(key('Enter'), body, at('cloze')), null, 'an answer is checked by its own box');
});

test('1–4 pick a choice — not when typed in a field, a select in a dialog, or with a modifier', () => {
  assert.deepEqual(sessionKey(key('2'), body, at('mcq')), { do: 'choose', index: 1 });
  assert.deepEqual(sessionKey(key('2'), { ...body, control: true }, at('mcq')), { do: 'choose', index: 1 }, 'with a “How sure?” pill focused');
  assert.equal(sessionKey(key('4'), body, at('mcq')), null, 'there are three choices');
  assert.equal(sessionKey(key('2'), { ...body, editable: true }, at('mcq')), null);
  assert.equal(sessionKey(key('2'), { ...body, overlay: true }, at('mcq')), null);
  assert.equal(sessionKey(key('2', { ctrlKey: true }), body, at('mcq')), null);
  assert.equal(sessionKey(key('2'), body, at('cloze')), null);
  assert.equal(sessionKey(key('2'), body, at('mcq', 'feedback')), null);
});
