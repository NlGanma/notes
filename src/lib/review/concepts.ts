import type { NoteDoc } from '../vault/types';
import { chunkNote, tokenize, type Chunk } from '../ai/rag';
import { hashString } from '../util';
import type { Level } from './mastery';

/**
 * What Review quizzes on: the ideas a note teaches, found in the note itself.
 * Every fact is a verbatim line or sentence of the note and every key (the
 * part to recall) is a span of that fact — so a question can never be
 * answered with something the notes don't say.
 */

export type ConceptKind = 'definition' | 'formula' | 'rule' | 'procedure' | 'vocab' | 'fact' | 'event';

export interface Fact {
  id: string;
  /** Verbatim line or sentence of the note (markdown included). */
  text: string;
  /** Verbatim part of `text` to recall; null = only usable as a key point. */
  key: string | null;
  /** An example the notes give (a sentence with its translation, "e.g.", a worked example). */
  example: boolean;
  /** From a handwriting transcript. */
  fromInk: boolean;
  /** A list item (one of several steps or rules). */
  item: boolean;
}

export interface Concept {
  id: string;
  noteId: string;
  chunkHash: string;
  blockId: string | null;
  /** Section heading the concept sits under. */
  section: string;
  name: string;
  kind: ConceptKind;
  facts: Fact[];
  /** Other concepts from the same passage (for "how are these related?"). */
  partners: string[];
  /** Highest level the notes support for this concept. */
  cap: Level;
  /** Too little in the notes to ask more than recall. */
  thin: boolean;
  origin: 'heuristic' | 'model';
  /** The teacher flagged it (highlighted, "on the exam"). */
  exam?: boolean;
  stale?: boolean;
}

export const UNTRANSCRIBED = '[Handwritten notes — not transcribed yet]';

const normName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function conceptId(noteId: string, name: string): string {
  return `c_${hashString(`${noteId}|${normName(name)}`)}`;
}

/** Content words of a text (what counts as "saying something"). */
export const contentWords = (s: string) => tokenize(s.replace(/\$[^$]*\$/g, ' math ')).filter((t) => t.length > 2 || /\d/.test(t));

const strip = (s: string) =>
  s
    .replace(/\*\*|==|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const EXAMPLE_LINE = /\b(?:e\.g\.|for example|for instance|por ejemplo|ex\.|worked example|classic use)|[.!?]\s*\([^)]{6,}\)\s*$|^\s*\p{Lu}[^.!?]{2,60}[.!?]\s*\([^)]{6,}\)/iu;
/** A line that introduces an example on the next line ("The classic use:", "e.g.:"). */
const RULE_THEN_EXAMPLE = /^(.{12,}?):\s+(\p{Lu}[^:]{2,}[.!?](?:\s*\([^)]{6,}\))?)\s*$/u;
const EXAMPLE_LEAD = /(?:example|classic use|e\.g\.|for instance|such as)[^.]*:\s*$/i;
const DATE_TERM = /^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{3,4}$|^\d{3,4}(?:\s*[–-]\s*\d{2,4})?$/i;
const GLOSS = /^\*\*([^*]{1,60}?)\*\*\s*(?:—|–|-|:)\s*(.+)$/;
const COLON_DEF = /^\*\*([^*]{2,60}?):\*\*\s*(.+)$/;
const IS_DEF = /\*\*([^*]{2,60}?)\*\*\s+(?:is|are|means|refers to|=|es|son|significa)\b/i;

/** The part of a fact to recall: its longest bold span, a highlight, inline math, or the value after a label. */
export function keyOf(text: string): string | null {
  // A display formula is recalled whole.
  if (/^\s*\$\$[\s\S]+\$\$\s*$/.test(text)) return text.trim();
  const bold = [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim().replace(/[:.]$/, '')).filter((b) => b.length >= 2);
  if (bold.length) return bold.sort((a, b) => b.length - a.length)[0];
  const hl = /==([^=]+)==/.exec(text)?.[1];
  if (hl) return hl.trim();
  // Inline math, read left to right so "$f$ is … on $[a,b]$" isn't paired across the text.
  const math = (text.match(/\$[^$\n]+\$/g) ?? []).find((m) => m.length >= 5);
  if (math) return math;
  const label = /^([^:]{3,40}):\s*(.{2,80})$/.exec(strip(text));
  if (label && !/\.\s/.test(label[2])) return label[2].replace(/[.]$/, '').trim();
  return null;
}

function fact(text: string, key: string | null, opts: Partial<Fact> = {}): Fact {
  return {
    // The key is part of the id: one gloss line gives two facts (term → meaning, meaning → term).
    id: `f_${hashString(`${text}|${key ?? ''}`)}`,
    text,
    key: key && text.includes(key) ? key : null,
    example: EXAMPLE_LINE.test(text),
    fromInk: /^\[Handwritten:/.test(text),
    item: false,
    ...opts,
  };
}

/** Lines of a chunk without list markers, quote markers or "Tip:" prefixes (verbatim otherwise). */
function bodyLines(chunk: Chunk): { text: string; item: boolean; heading: boolean }[] {
  return chunk.text
    .split('\n')
    // To-do items are tasks, not study material.
    .filter((raw) => !/^\s*[-*+]\s+\[[ xX]\]\s/.test(raw))
    // Several glosses or definitions on one line ("**Jump:** … **Infinite:** …") are separate ideas.
    .flatMap((raw) => raw.split(/(?<=[.;])\s+(?=\*\*[^*]{1,60}(?::\*\*|\*\*\s*(?:—|–|:)))/))
    .map((raw) => {
      const heading = /^#{1,6}\s/.test(raw);
      const item = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(raw);
      const text = raw
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/^\s*>\s*/, '')
        .replace(/^\*\*(?:Tip|Note|Important|Warning|AI note):\*\*\s*/i, '')
        .trim();
      return { text, item, heading };
    })
    .filter((l) => l.text && l.text !== UNTRANSCRIBED);
}

/** Splits a line into sentences, keeping an example's translation with it. */
function sentences(line: string): string[] {
  const parts = line.split(/(?<=[.!?])\s+(?=[\p{Lu}¿¡])/u);
  return parts.length > 1 ? parts : [line];
}

/** Whether a note's language class: glosses are vocabulary there. */
export interface ExtractOpts {
  languageClass?: boolean;
}

/**
 * Concepts from a note's own structure, instantly and with no model:
 * `**term** — gloss` lines (vocabulary or definitions), `**Term:** …` and
 * `**term** is …` definitions, and each section heading with the lines under
 * it (rules, steps, formulas, examples).
 */
export function heuristicConcepts(note: NoteDoc, opts: ExtractOpts = {}): Concept[] {
  const out: Concept[] = [];
  const add = (c: Omit<Concept, 'id' | 'partners' | 'cap' | 'thin' | 'origin'>) => {
    const id = conceptId(note.meta.id, c.name);
    const existing = out.find((x) => x.id === id);
    if (existing) {
      for (const f of c.facts) if (!existing.facts.some((g) => g.id === f.id)) existing.facts.push(f);
      return;
    }
    out.push({ ...c, id, partners: [], cap: 0, thin: false, origin: 'heuristic' });
  };
  for (const chunk of chunkNote(note)) {
    const lines = bodyLines(chunk);
    const section = chunk.section.split(' › ').pop() ?? '';
    const sectionFacts: Fact[] = [];
    const base = { noteId: note.meta.id, chunkHash: chunk.hash, blockId: chunk.blockIds[0] ?? null, section };
    let glosses = 0;
    let exampleNext = false;
    for (const l of lines) {
      if (l.heading) continue;
      const g = GLOSS.exec(l.text);
      const cd = COLON_DEF.exec(l.text);
      if (g && !COLON_DEF.test(l.text)) {
        const term = g[1].trim();
        const gloss = g[2].trim();
        const wordsIn = (x: string) => (strip(x).match(/\p{L}+/gu) ?? []).length;
        const short = wordsIn(term) <= 4 && wordsIn(gloss) <= 5;
        const vocab = !!opts.languageClass && short;
        glosses++;
        add({
          ...base,
          name: term,
          kind: vocab ? 'vocab' : DATE_TERM.test(term) ? 'event' : 'definition',
          facts: vocab ? [fact(l.text, term, { item: l.item }), fact(l.text, gloss.replace(/\*\*/g, ''), { item: l.item })] : [fact(l.text, term, { item: l.item })],
        });
        continue;
      }
      if (cd) {
        add({ ...base, name: cd[1].trim(), kind: 'definition', facts: [fact(l.text, cd[1].trim(), { item: l.item })] });
        continue;
      }
      for (const s of sentences(l.text)) {
        if (contentWords(s).length < 3 && !/\$/.test(s)) {
          if (EXAMPLE_LEAD.test(s)) exampleNext = true;
          continue;
        }
        const d = IS_DEF.exec(s);
        if (d && !l.item) {
          add({ ...base, name: d[1].trim(), kind: 'definition', facts: [fact(s, d[1].trim())] });
          continue;
        }
        // "Use the preterite for…: Ayer comí paella. (Yesterday I ate paella.)" is a rule and its example.
        const ruleEx = RULE_THEN_EXAMPLE.exec(s);
        if (ruleEx && contentWords(ruleEx[1]).length >= 3 && EXAMPLE_LINE.test(ruleEx[2])) {
          sectionFacts.push(fact(ruleEx[1], keyOf(ruleEx[1]), { item: l.item }), fact(ruleEx[2], null, { item: l.item, example: true }));
          exampleNext = false;
          continue;
        }
        const f = fact(s, keyOf(s), { item: l.item });
        if (exampleNext) f.example = true;
        exampleNext = EXAMPLE_LEAD.test(s);
        sectionFacts.push(f);
      }
    }
    // The section itself, with the lines under it (unless it was only a list of glosses).
    if (sectionFacts.length && section && !(glosses >= 2 && sectionFacts.length <= 1)) {
      const items = sectionFacts.filter((f) => f.item).length;
      const kind: ConceptKind = /\$\$/.test(chunk.text) ? 'formula' : items >= 2 ? 'rule' : 'fact';
      add({ ...base, name: section, kind, facts: sectionFacts.slice(0, 8) });
    } else if (sectionFacts.length && !section && sectionFacts.reduce((n, f) => n + contentWords(f.text).length, 0) >= 6) {
      // Text before the first heading: named after the note.
      const kind: ConceptKind = /\$\$/.test(chunk.text) ? 'formula' : 'fact';
      add({ ...base, name: (note.meta.title || 'This note').split(/\s+[—–-]\s+/)[0], kind, facts: sectionFacts.slice(0, 8) });
    }
  }
  for (const c of out) {
    c.exam = c.facts.some((f) => /==|on the exam|will be on/i.test(f.text));
    c.partners = out.filter((o) => o !== c && o.chunkHash === c.chunkHash).map((o) => o.id);
    Object.assign(c, capOf(c));
  }
  return out.filter((c) => c.facts.length).slice(0, 16);
}

/**
 * How deep the notes let Review go: vocabulary and thin concepts are recall
 * only; an explanation allows "explain"; an example or a list of steps allows
 * "apply"; a related idea in the same passage allows "connect".
 */
export function capOf(c: Pick<Concept, 'kind' | 'facts' | 'partners'>): { cap: Level; thin: boolean } {
  const words = c.facts.reduce((n, f) => n + contentWords(f.text).length, 0);
  if (c.kind === 'vocab') return { cap: 0, thin: false };
  if (words < 6) return { cap: 0, thin: true };
  let cap: Level = 0;
  if (c.facts.some((f) => contentWords(f.text).length - (f.key ? contentWords(f.key).length : 0) >= 8) || c.facts.length >= 2) cap = 1;
  if (c.facts.some((f) => f.example) || c.facts.filter((f) => f.item).length >= 2) cap = 2;
  if (c.partners.length && cap >= 1) cap = 3;
  return { cap, thin: false };
}

/** Sections a note has that can't be reviewed yet (handwriting with no transcript). */
export function notReviewable(note: NoteDoc): string[] {
  return chunkNote(note)
    .filter((c) => c.text.includes(UNTRANSCRIBED))
    .map((c) => c.section.split(' › ').pop() || note.meta.title || 'Handwriting');
}
