import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { unlabeled } from './fixtures';

/** What an answer looks like in the panel: rendered to static HTML (no browser). */

const mem = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) },
});

const { MessageView, copyText, needsLegacyCheck, shownMarkdown } = await import('../../src/components/ai/Message');
const { trimExcerpt } = await import('../../src/components/ai/Citations');
const { LABELS } = await import('../../src/lib/ai/policy');
type Msg = import('../../src/state/assistant').ChatMsg;

const msg = (over: Partial<Msg>): Msg => ({ id: 'm1', role: 'assistant', content: '', status: 'done', grounding: 'note', at: 1, ...over });
const noop = () => undefined;
/** Static HTML of a message (React's note that layout effects don't run on a server is expected here). */
function render(m: Msg, props: Record<string, unknown> = {}): string {
  const error = console.error;
  console.error = (...a: unknown[]) => void (/useLayoutEffect does nothing on the server/.test(String(a[0])) || error(...a));
  try {
    return renderToStaticMarkup(createElement(MessageView, { msg: m, citations: m.role === 'assistant', ...props }));
  } finally {
    console.error = error;
  }
}
const count = (html: string, re: RegExp) => (html.match(new RegExp(re.source, 'g')) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const SOURCES = [
  { n: 1, noteId: 'a', title: 'Lecture 4 — Limits & Continuity', section: 'Limit laws', folder: 'Calculus I', blockId: null, text: 'Sum: lim(f+g) = lim f + lim g.' },
  { n: 2, noteId: 'a', title: 'Lecture 4 — Limits & Continuity', section: 'Squeeze theorem', folder: 'Calculus I', blockId: null, text: 'If g ≤ f ≤ h …' },
];
const OWN = ':::outside\nThe capital of Peru is Lima.\n:::';

test('the student’s bubble shows the menu action they picked, not the prompt the model got', () => {
  const html = render(msg({ role: 'user', content: 'Show me the examples my notes give for this… write "NOT IN NOTES: an example of this".', label: 'Give an example' }));
  assert.match(html, /Give an example/);
  assert.ok(!/NOT IN NOTES/.test(html), html);
  // A typed question has no label: it shows as typed.
  assert.match(render(msg({ role: 'user', content: 'What is a limit?' })), /What is a limit\?/);
});

test('an answer from the AI’s own knowledge carries its banner and box — and no third warning', () => {
  const m = msg({ ownOnly: true, coverage: 'none', banner: 'none', shown: OWN });
  assert.equal(needsLegacyCheck(m, true), false, 'no legacy check bar for it');
  assert.equal(needsLegacyCheck(msg({ content: 'Old answer [1].' }), true), true, 'older answers without the check still get one');
  const html = render(m, { onForce: noop });
  assert.match(html, /proceed with caution and check it against your class materials/, 'the banner says it is the AI’s own knowledge');
  assert.match(html, /class="outside-head"[^>]*>.*Not from your notes · the AI’s own knowledge — proceed with caution/, 'the box keeps its header');
  assert.ok(!/grounding-item/.test(html), 'no pill repeating it');
});

test('no example in the notes: the banner says the example below is the AI’s own (and says nothing more with own knowledge off)', () => {
  const given = render(msg({ ownOnly: true, coverage: 'none', banner: 'noExample', shown: ':::outside\nFor example, the Golgi packs proteins.\n:::' }));
  assert.match(given, /don’t include an example of this/);
  assert.match(given, /the answer below is from the AI’s own general knowledge, not your notes — proceed with caution/);
  const off = render(msg({ ownOnly: true, coverage: 'none', banner: 'noExample' }));
  assert.match(off, /don’t include an example of this/);
  assert.ok(!/answer below/.test(off), 'no answer below to speak of');
});

test('“sources added by Nib” is the green pill’s tooltip, not a pill of its own', () => {
  const html = render(msg({ content: 'x', shown: 'Sum: $\\lim(f+g) = \\lim f + \\lim g$ [1].', check: { claims: 1, supported: 1, weak: 0, contained: 0, outside: 0, repaired: 1 } }));
  assert.ok(!/added by Nib/.test(text(html)), 'no pill');
  assert.match(html, /class="grounding-item is-cited" title="[^"]*Nib added or corrected 1 citation/);
});

test('one pill wording for parts from the AI’s own knowledge', () => {
  assert.equal(LABELS.ownParts(1), '1 part from the AI’s own knowledge');
  const html = render(msg({ content: 'x', shown: `Sum [1].\n\n${OWN}`, check: { claims: 1, supported: 1, weak: 0, contained: 0, outside: 0, repaired: 0 } }));
  assert.match(text(html), /1 part from the AI’s own knowledge/);
  assert.ok(!/part not from your notes/.test(text(html)));
});

test('“worked with your notes’ method” is said only when some of the answer is from the notes', () => {
  const derived = { claims: 2, weak: 0, outside: 0, repaired: 0, derived: 1 };
  const collapsed = render(msg({ content: 'x', banner: 'collapsed', shown: ':::outside auto\nAll of it.\n:::', check: { ...derived, supported: 0, contained: 2 } }));
  assert.match(collapsed, /couldn’t match this answer to your notes/);
  assert.ok(!collapsed.includes(LABELS.computed), 'not under a banner saying none of it matched');
  assert.ok(!render(msg({ content: 'x', shown: '$3+3=6$', check: { ...derived, supported: 0, contained: 0 } })).includes(LABELS.computed));
  assert.ok(render(msg({ content: 'x', shown: 'Use the sum law [1].\n\n$3+3=6$', check: { ...derived, supported: 1, contained: 0 } })).includes(LABELS.computed));
});

test('a formula still being written is left out, not shown as raw TeX', () => {
  const streaming = msg({ status: 'streaming', content: 'If $g(x) \\le f(x)$ near $a$ and $\\lim g = \\lim' });
  assert.equal(shownMarkdown(streaming), 'If $g(x) \\le f(x)$ near $a$ and');
  assert.ok(!/\\lim|\$/.test(text(render(streaming))), text(render(streaming)));
  // Cut off at the token limit: the half formula goes, the citation Nib added stays.
  const cut = msg({ truncated: true, content: 'x', shown: 'Sum: $\\lim(f+g)$. Product: $\\lim (fg) = (\\lim [1]', sources: SOURCES });
  assert.equal(shownMarkdown(cut), 'Sum: $\\lim(f+g)$. Product: [1]');
  // A finished answer is shown as it is.
  assert.equal(shownMarkdown(msg({ content: 'x', shown: 'It costs $5' })), 'It costs $5');
  // All that arrived is a formula still open: the caret still shows something is coming.
  assert.match(render(msg({ status: 'streaming', content: '$\\lim_{x' })), /class="caret"/);
});

test('an error says what happened and offers Retry right there', () => {
  const html = render(msg({ status: 'error', error: 'The model server had a problem (HTTP 503: server busy). It was retried automatically; try again in a moment.' }), { onRegenerate: noop });
  assert.match(html, /class="msg-error"[\s\S]*Retry[\s\S]*AI settings/);
  assert.equal(count(text(html), /Retry/), 1);
});

test('a stopped answer from the AI’s own knowledge has one Retry, under it', () => {
  const html = render(msg({ status: 'stopped', ownOnly: true, banner: 'none', shown: ':::outside\nIn general, who won the\n:::' }), { onRegenerate: noop });
  assert.equal(count(text(html), /Retry/), 1, text(html));
  assert.match(html, /class="msg-stopped">Stopped<\/div>/);
  // Nothing arrived: Retry sits next to "Stopped".
  assert.match(render(msg({ status: 'stopped' }), { onRegenerate: noop }), /class="msg-stopped">Stopped<button[^>]*>.*Retry/);
});

test('“Search my notes anyway” only while the notes haven’t been searched for this answer', () => {
  const gated = msg({ ownOnly: true, banner: 'none', coverage: 'none', shown: OWN });
  assert.match(render(gated, { onForce: noop }), /Search my notes anyway/);
  assert.ok(!/Search my notes anyway/.test(render({ ...gated, forced: true }, { onForce: noop })), 'not again after searching');
  const asked = msg({ banner: 'none', coverage: 'none', gaps: ['the capital of Peru'], shown: OWN, check: { claims: 0, supported: 0, weak: 0, contained: 0, outside: 0, repaired: 0 } });
  assert.ok(!/Search my notes anyway/.test(render(asked, { onForce: noop })), 'not when the notes were asked already');
  // Homework with nothing linked: searching can't help, linking notes does.
  const unlinked = render(msg({ grounding: 'homework', ownOnly: true, banner: 'noLinked', shown: OWN }), { onForce: noop, onLink: noop });
  assert.ok(!/Search my notes anyway/.test(unlinked));
  assert.match(unlinked, /Link notes…/);
  assert.match(unlinked, /haven’t linked any notes/);
});

test('the banners point at the boxes and the switch as they really are', () => {
  assert.ok(!/“Not from your notes” box/.test(LABELS.partial), 'contained sentences are boxed under “Not found in your notes”');
  assert.match(LABELS.partial, /amber box/);
  assert.match(LABELS.partial, /proceed with caution/);
  const off = (grounding: Msg['grounding']) => text(render(msg({ grounding, ownOnly: true, banner: 'noneOff', coverage: 'none' })));
  // One switch for both: Ask your notes has no chat settings of its own.
  assert.match(off('library'), /answer only from your notes.*Settings → Local AI/);
  assert.ok(!/Configure chat|Only my notes/.test(off('library')));
  assert.match(off('note'), /answer only from your notes.*Settings → Local AI/);
});

test('Copy says which notes the [n] point to', () => {
  const copied = copyText(msg({ content: 'x', shown: 'Squeeze it [2].', sources: SOURCES }));
  assert.match(copied, /^Squeeze it \[2\]\.\n\nSources: \[2\] Lecture 4 — Limits & Continuity › Squeeze theorem$/);
  assert.equal(copyText(msg({ content: 'x', shown: 'Nothing cited.', sources: SOURCES })), 'Nothing cited.');
  // The AI's own part keeps its label when copied.
  assert.match(copyText(msg({ ownOnly: true, shown: OWN })), /^> \*\*Not from your notes/);
});

test('an untitled note is cited by the name the app gives it, not the index’s “Untitled”', async () => {
  const { useVault } = await import('../../src/state/vault');
  const prev = useVault.getState().notes;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell membranes' }] }] };
  useVault.setState({ notes: { u1: { version: 1, meta: { id: 'u1', title: '', folder: '', tags: [], created: 1, updated: 1, paper: 'ruled' }, content: doc } } as never });
  try {
    const src = { n: 1, noteId: 'u1', title: 'Untitled', section: '', folder: '', blockId: null, text: 'Cell membranes are lipid bilayers.' };
    assert.match(copyText(msg({ content: 'x', shown: 'Lipids [1].', sources: [src] })), /Sources: \[1\] Cell membranes$/);
    const { SourcesList } = await import('../../src/components/ai/Citations');
    assert.match(text(renderToStaticMarkup(createElement(SourcesList, { content: 'Lipids [1].', sources: [src] }))), /1 Cell membranes Note/);
    const gone = { ...src, noteId: 'deleted' };
    assert.match(copyText(msg({ content: 'x', shown: 'Lipids [1].', sources: [gone] })), /Sources: \[1\] Untitled$/, 'a note gone since keeps the stored name');
  } finally {
    useVault.setState({ notes: prev });
  }
});

test('a cited passage previews highlights as words, not ==marks==', () => {
  assert.equal(trimExcerpt('## Squeeze theorem\nThe professor said this one ==will definitely be on the exam== — know it.'), 'The professor said this one will definitely be on the exam — know it.');
  assert.equal(trimExcerpt('a == b'), 'a == b');
});

test('nothing in a rendered answer escapes its label', () => {
  // The extra pill is gone for these answers, but the box still wraps every word of them.
  assert.ok(!unlabeled(render(msg({ ownOnly: true, banner: 'none', shown: OWN }))).includes('Lima'));
});
