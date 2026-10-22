import { create } from 'zustand';
import { useVault } from './vault';
import { useAI } from './ai';
import { chatJSON, PreemptedError } from '../lib/ai/engine';
import { parseJSONLoose } from '../lib/ai/json';
import { chunkNote, tokenize, type Chunk } from '../lib/ai/rag';
import { expandProof } from '../lib/ai/quote';
import { classForFolder, classInfo } from '../lib/classes';
import { buildReviewTree, groupKeyOf, isReviewable, selectionLabel } from '../lib/review/tree';
import { conceptId, contentWords, capOf, heuristicConcepts, keyOf, notReviewable, type Concept, type Fact } from '../lib/review/concepts';
import { assertGroundedItem, blankOut, buildItem, hintFor, masteryNeeds, mulberry32, validateNudge, validateQuestion, type Item, type ModelQuestion } from '../lib/review/items';
import { covers, gradeShort, hasKey, isDontKnow, namesPoint, quickRubric, scoreRubric, verdictOf, type Grade, type GraderReply, type Verdict } from '../lib/review/grade';
import { freshState, isDue, isMastered, recordAnswer, scoreOf, type Confidence, type ConceptState, type GradedBy, type Level } from '../lib/review/mastery';
import { newSession, pickNext, requeue, skipConcept, summarize, type PoolEntry, type SessionOpts, type SessionState, type SessionSummary } from '../lib/review/session';
import { conceptsTask, gradeTask, LEVEL_HINT, MASTERY_ENGINE_PROMPT, nudgeTask, questionTask, SCHEMAS } from '../lib/review/prompts';
import { debounce, hashString, uid } from '../lib/util';
import type { NoteDoc, VaultBackend } from '../lib/vault/types';

/**
 * Review: retrieval practice on any mix of notes, run by the Mastery Engine.
 * Concepts come from the notes (code first, the model only for passages the
 * rules found little in); every question's answer is the note's own text;
 * grading is code first; the learner model decides what comes next.
 */

interface CachedQuestion {
  prompt: string;
  points: string[];
  fact: string;
}

export interface ReviewFile {
  version: 1;
  /** Concepts the model found (heuristic ones are recomputed from the notes). */
  modelConcepts: Record<string, Concept>;
  /** Passages the model has read (by chunk hash). */
  extracted: Record<string, { model: string; at: number }>;
  states: Record<string, ConceptState>;
  /** Model-phrased questions that passed the checks, by item key and passage. */
  questions: Record<string, CachedQuestion[]>;
  /** Items the student reported as wrong. */
  bad: string[];
  sessions: SessionSummary[];
}

const EMPTY: ReviewFile = { version: 1, modelConcepts: {}, extracted: {}, states: {}, questions: {}, bad: [], sessions: [] };

export interface PoolMeta extends PoolEntry {
  name: string;
  groupName: string;
  color?: string;
  thin: boolean;
}

export interface Feedback {
  s: number;
  verdict: Verdict;
  note?: string;
  /** Key points the answer missed (verbatim). */
  missed?: string[];
  /** Was sure and wrong. */
  hypercorrect?: boolean;
  /** Right, but guessing. */
  lucky?: boolean;
  before: number;
  after: number;
  mastered: boolean;
}

export interface Current {
  item: Item;
  concept: Concept;
  phase: 'ask' | 'grading' | 'self' | 'feedback';
  answer?: string;
  choice?: number;
  conf?: Confidence | null;
  hint?: string;
  hintUsed: boolean;
  feedback?: Feedback;
  /** A second try after a miss (not counted): its score — none when only the student can tell — or being checked. */
  retry?: { answer: string; s?: number; checking?: boolean };
  revealed: boolean;
  /** Answered "I don't know" (or typed it). */
  dontKnow?: boolean;
  /** The student said how it went themselves (a self-check, or a free answer no one else could grade). */
  selfGraded?: boolean;
  firstInSession: boolean;
  wasDue: boolean;
  stateBefore: ConceptState;
  /** The session before this answer was counted (so "I was right" and "Report" can recount or undo it). */
  sessBefore?: SessionState;
  overridden?: boolean;
  shownAt: number;
}

interface ReviewState {
  loaded: boolean;
  file: ReviewFile;
  /** Notes picked for review. */
  selection: string[];
  opts: SessionOpts;
  /** The model is reading passages for more concepts. */
  reading: { done: number; total: number } | null;
  session: SessionState | null;
  pool: PoolMeta[];
  current: Current | null;
  summary: SessionSummary | null;
  /** "I was right" overrides used this session (at most 3). */
  overrides: number;
  misconceptions: SessionSummary['misconceptions'];
  /** Learner states when the session started (for "improved" in the summary). */
  startStates: Record<string, ConceptState | undefined>;

  load(): Promise<void>;
  /** Has the model look for more concepts in passages the rules found little in (background). */
  readMore(noteIds: string[]): Promise<void>;
  setSelection(ids: string[]): void;
  /**
   * A request to review these notes (⌘K, a class page, the sidebar): a session in progress ends, its
   * summary staying on screen until it's closed, and the picker then shows them.
   */
  request(ids: string[]): void;
  setOpts(p: Partial<SessionOpts>): void;
  start(noteIds?: string[]): void;
  /** How sure the student says they are about the question on screen. */
  setConf(conf: Confidence | null): void;
  submit(answer: string, conf: Confidence | null): Promise<void>;
  choose(index: number, conf: Confidence | null): void;
  dontKnow(): void;
  selfGrade(s: number): void;
  showHint(): void;
  retry(answer: string): Promise<void>;
  reveal(): void;
  next(): void;
  override(): void;
  report(): void;
  /** Takes a report back: the question can be asked again. */
  unreport(key: string): void;
  end(): void;
  closeSummary(): void;
}

let rng = mulberry32(1);
let control: AbortController | null = null;

/** The vault the review file was read from — and is saved to, whichever vault is open now. */
let loadedFor: VaultBackend | null = null;
/** That read, while it's in progress. */
let pendingRead: Promise<void> | null = null;
/** Bumped when another vault's file is read: a model job started before keeps nothing it found. */
let generation = 0;
/** Changes not written yet. */
let dirty = false;
/** The vault's file couldn't be read, nor kept aside: it's left as it is. */
let readOnly = false;

/** Writes the review file to the vault it was read from — never before it was read, nor over one that couldn't be. */
function writeFile(sync: boolean) {
  const backend = loadedFor;
  if (!dirty || !backend || readOnly || !useReview.getState().loaded) return;
  dirty = false;
  const text = JSON.stringify(useReview.getState().file);
  if (sync && backend.writeKVSync) backend.writeKVSync('review', text);
  else backend.writeKV('review', text).catch((e) => console.warn('review not saved', e));
}
const persist = debounce(() => writeFile(false), 800);

/** Saves what Review changed now, instead of in a moment (while the window closes: synchronously, where the vault can). */
export function flushReview(sync = false) {
  persist.cancel();
  writeFile(sync);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A saved review file with anything malformed left out; null when it isn't one this version can read. */
export function parseReviewFile(raw: string): ReviewFile | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.version !== 1) return null;
  const entries = <T>(x: unknown, ok: (e: Record<string, unknown>) => boolean) =>
    (isRecord(x) ? Object.fromEntries(Object.entries(x).filter(([, e]) => isRecord(e) && ok(e))) : {}) as Record<string, T>;
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  const states = entries<ConceptState>(v.states, (s) => typeof s.p === 'number' && typeof s.attempts === 'number');
  for (const [id, s] of Object.entries(states)) states[id] = { ...freshState(0), ...s, recent: list(s.recent), correctKeys: list(s.correctKeys) };
  return {
    version: 1,
    modelConcepts: entries<Concept>(
      v.modelConcepts,
      (c) => typeof c.id === 'string' && typeof c.noteId === 'string' && typeof c.chunkHash === 'string' && typeof c.name === 'string' && list(c.facts).length > 0 && list(c.facts).every((f) => isRecord(f) && typeof f.text === 'string'),
    ),
    extracted: entries(v.extracted, () => true),
    states,
    questions: (isRecord(v.questions)
      ? Object.fromEntries(Object.entries(v.questions).filter(([, q]) => Array.isArray(q) && q.every((x) => isRecord(x) && typeof x.prompt === 'string' && typeof x.fact === 'string' && Array.isArray(x.points))))
      : {}) as ReviewFile['questions'],
    bad: list(v.bad).filter((x): x is string => typeof x === 'string'),
    sessions: list(v.sessions).filter(isRecord) as unknown as SessionSummary[],
  };
}

/**
 * The file without what can't be used any more: the model's findings and the questions it phrased for
 * passages no note has now (every edit of a passage leaves its old ones behind). What the student learned
 * and reported is kept.
 */
export function pruneFile(file: ReviewFile, notes: Record<string, NoteDoc>): ReviewFile {
  const live = new Set(Object.values(notes).flatMap((n) => chunkNote(n).map((c) => c.hash)));
  const keep = <T>(rec: Record<string, T>, ok: (key: string, v: T) => boolean): Record<string, T> => {
    const kept = Object.entries(rec).filter(([k, v]) => ok(k, v));
    return kept.length === Object.keys(rec).length ? rec : Object.fromEntries(kept);
  };
  const extracted = keep(file.extracted, (hash) => live.has(hash));
  const modelConcepts = keep(file.modelConcepts, (_, c) => !!notes[c.noteId] && live.has(c.chunkHash));
  const questions = keep(file.questions, (key) => live.has(key.slice(key.lastIndexOf('#') + 1)));
  return extracted === file.extracted && modelConcepts === file.modelConcepts && questions === file.questions ? file : { ...file, extracted, modelConcepts, questions };
}

/** A vault's review file: fresh when it has none; one this version can't read is kept aside first — or, if it can't be, left alone. */
async function readFile(backend: VaultBackend | null): Promise<{ file: ReviewFile; writable: boolean }> {
  const raw = backend ? await backend.readKV('review').catch(() => null) : null;
  if (raw == null) return { file: EMPTY, writable: true };
  const file = parseReviewFile(raw);
  if (file) return { file, writable: true };
  try {
    await backend!.writeKV(`review-unreadable-${Date.now()}`, raw);
    return { file: EMPTY, writable: true };
  } catch {
    return { file: EMPTY, writable: false };
  }
}

/** The class or folder a note belongs to, with its colour; and whether it's a language class. */
function groupOf(note: NoteDoc) {
  const { folderMeta } = useVault.getState();
  const cls = classForFolder(note.meta.folder, folderMeta);
  const info = cls ? classInfo(cls, folderMeta[cls]) : null;
  const top = note.meta.folder.split('/')[0] ?? '';
  const chapter = info ? note.meta.folder.slice(info.path.length + 1) : note.meta.folder.slice(top.length + 1);
  return {
    key: groupKeyOf(note, folderMeta),
    name: info?.name ?? (top || 'Unfiled'),
    color: info?.color,
    chapter,
    language: info?.icon === 'languages' || /spanish|french|german|italian|latin|chinese|japanese|korean|español|language/i.test(info?.name ?? ''),
  };
}

/** Concepts are worked out again only when the note, the model's findings or the class's language change. */
const conceptCache = new WeakMap<NoteDoc, { modelConcepts: ReviewFile['modelConcepts']; language: boolean; concepts: Concept[] }>();

/** Every concept of a note: from its structure, plus any the model found in passages the rules missed. */
export function conceptsOf(note: NoteDoc, file: ReviewFile = useReview.getState().file): Concept[] {
  const language = groupOf(note).language;
  const hit = conceptCache.get(note);
  if (hit && hit.modelConcepts === file.modelConcepts && hit.language === language) return hit.concepts;
  const concepts = readConcepts(note, file, language);
  conceptCache.set(note, { modelConcepts: file.modelConcepts, language, concepts });
  return concepts;
}

function readConcepts(note: NoteDoc, file: ReviewFile, language: boolean): Concept[] {
  const heur = heuristicConcepts(note, { languageClass: language });
  const live = new Set(chunkNote(note).map((c) => c.hash));
  const fromModel = Object.values(file.modelConcepts)
    .filter((c) => c.noteId === note.meta.id && live.has(c.chunkHash) && !heur.some((h) => h.id === c.id))
    .map((c) => ({ ...c })); // never mutate the stored file
  // A line the model named as its own idea is asked under that name only.
  const named = new Set(fromModel.map((c) => c.facts[0]?.text));
  for (const h of heur) {
    if (h.facts.length <= 1 || !h.facts.some((f) => named.has(f.text))) continue;
    h.facts = h.facts.filter((f) => !named.has(f.text));
    Object.assign(h, capOf(h));
  }
  const all = [...heur.filter((h) => h.facts.length), ...fromModel];
  for (const c of all) c.partners = all.filter((o) => o !== c && o.chunkHash === c.chunkHash).map((o) => o.id);
  for (const c of all) Object.assign(c, capOf(c), { needs: masteryNeeds(c) });
  return all;
}

/** 0–100 mastery of a note's concepts (for the picker). */
export function noteMastery(note: NoteDoc, now = Date.now()): number | null {
  const { states } = useReview.getState().file;
  const cs = conceptsOf(note);
  const seen = cs.filter((c) => states[c.id]?.attempts);
  if (!seen.length) return null;
  const done = cs.filter((c) => states[c.id] && isMastered(states[c.id], c.cap, c.needs)).length;
  return Math.round((done / cs.length) * 100) || Math.min(99, Math.round((seen.length / cs.length) * 20));
}

/** Notes with an idea due for review now, and how many ideas are due (only notes that still exist count). */
export function dueNotes(now = Date.now()): { ids: string[]; concepts: number } {
  const { file } = useReview.getState();
  if (!Object.values(file.states).some((s) => isDue(s, now))) return { ids: [], concepts: 0 };
  const ids: string[] = [];
  let concepts = 0;
  for (const n of Object.values(useVault.getState().notes)) {
    if (!isReviewable(n)) continue;
    const due = conceptsOf(n, file).filter((c) => isDue(file.states[c.id], now)).length;
    if (due) ids.push(n.meta.id);
    concepts += due;
  }
  return { ids, concepts };
}

/** How many ideas are due across the vault (for the sidebar). */
export function dueCount(now = Date.now()): number {
  return dueNotes(now).concepts;
}

const where = (c: Concept, title: string) => [title, c.section].filter(Boolean).join(' › ');
/** The line of the notes an item asks about. */
export const factOf = (item: Item, c: Concept): Fact | undefined => c.facts.find((x) => x.id === item.factId) ?? c.facts[0];

/** The number of the question on screen (the "9" of "9 / 25"). */
export const questionNumber = (session: SessionState, current: Pick<Current, 'phase'> | null) =>
  Math.min(session.index + (current?.phase === 'feedback' ? 0 : 1), session.opts.length);

/**
 * Whether "I was right" can apply: to an answer the student wrote and code or the model graded —
 * not to "I don't know", a self-check, or a choice (which is compared exactly).
 */
export const canOverride = (cur: Pick<Current, 'answer' | 'dontKnow' | 'selfGraded' | 'item'>) =>
  !!cur.answer?.trim() && !cur.dontKnow && !cur.selfGraded && cur.item.format !== 'mcq';

export const useReview = create<ReviewState>((set, get) => {
  const save = (file: ReviewFile) => {
    set({ file });
    dirty = true;
    persist();
  };

  const noteOf = (id: string) => useVault.getState().notes[id];
  const chunkOf = (c: Concept): Chunk | undefined => {
    const n = noteOf(c.noteId);
    return n ? chunkNote(n).find((x) => x.hash === c.chunkHash) : undefined;
  };
  const conceptById = (id: string): Concept | undefined => {
    const meta = get().pool.find((p) => p.id === id);
    const n = meta && noteOf(meta.noteId);
    return n ? conceptsOf(n).find((c) => c.id === id) : undefined;
  };
  const online = () => {
    const ai = useAI.getState();
    return ai.status === 'online' && !!ai.chatModel;
  };

  // ------------------------------------------------------------ the model's jobs (all checked in code)

  /** Concepts in passages the rules found little in: the model names them, code cuts the note's own line. */
  const extract = async (noteIds: string[]) => {
    if (!online()) return;
    const ai = useAI.getState();
    const gen = generation;
    const jobs: { note: NoteDoc; chunks: Chunk[] }[] = [];
    for (const id of noteIds) {
      const note = noteOf(id);
      if (!note) continue;
      const heur = heuristicConcepts(note, { languageClass: groupOf(note).language });
      const thin = chunkNote(note).filter(
        (ch) =>
          !get().file.extracted[ch.hash] &&
          contentWords(ch.text).length >= 12 &&
          // About one idea per short paragraph; fewer means the rules missed some.
          heur.filter((c) => c.chunkHash === ch.hash).length < Math.max(1, Math.floor(ch.text.length / 250)),
      );
      if (thin.length) jobs.push({ note, chunks: thin.slice(0, 6) });
    }
    if (!jobs.length) return;
    set({ reading: { done: 0, total: jobs.length } });
    for (const { note, chunks } of jobs) {
      try {
        const { value } = await chatJSON(
          {
            label: 'Review · reading your notes',
            model: ai.chatModel,
            priority: 'background',
            temperature: 0,
            maxTokens: 400,
            schema: SCHEMAS.concepts,
            messages: [
              { role: 'system', content: MASTERY_ENGINE_PROMPT },
              { role: 'user', content: conceptsTask(chunks.map((ch, i) => ({ n: i + 1, where: [note.meta.title, ch.section].filter(Boolean).join(' › '), text: ch.text }))) },
            ],
          },
          (v) => (Array.isArray((v as { concepts?: unknown })?.concepts) || (v as { skip?: boolean })?.skip ? (v as { concepts?: unknown[] }) : null),
          parseJSONLoose,
        );
        // Another vault was opened meanwhile: what was found belongs to the one that's gone.
        if (gen !== generation) return;
        const found: Concept[] = [];
        const known = conceptsOf(note);
        for (const raw of (value.concepts ?? []) as Record<string, unknown>[]) {
          const ch = chunks[Number(raw.source) - 1];
          const name = String(raw.name ?? '').trim();
          if (!ch || name.length < 2) continue;
          const span = expandProof(String(raw.proof ?? ''), ch.text);
          if (!span) continue;
          // The name must come from the passage too.
          const nameWords = tokenize(name);
          const passage = new Set(tokenize(`${ch.section} ${ch.text}`));
          if (!nameWords.length || nameWords.filter((w) => passage.has(w)).length / nameWords.length < 0.5) continue;
          const key = String(raw.key ?? '').trim();
          const f: Fact = {
            id: `f_${hashString(span)}`,
            text: span,
            key: key && span.includes(key) ? key : keyOf(span),
            example: false,
            fromInk: /^\[Handwritten:/.test(span),
            item: false,
          };
          const id = conceptId(note.meta.id, name);
          // A line already asked as its own idea is a duplicate; one inside a catch-all section is not
          // (it moves to the named idea — see conceptsOf).
          const dup = [...known, ...found].some(
            (c) => c.id === id || jaccard(c.name, name) >= 0.6 || (c.facts.some((x) => x.text === span) && (c.origin === 'model' || c.facts.length <= 1 || c.facts[0].text === span)),
          );
          if (dup) continue;
          const c: Concept = {
            id,
            noteId: note.meta.id,
            chunkHash: ch.hash,
            blockId: ch.blockIds[0] ?? null,
            section: ch.section.split(' › ').pop() ?? '',
            name,
            kind: 'fact',
            facts: [f],
            partners: [],
            cap: 0,
            thin: false,
            origin: 'model',
          };
          Object.assign(c, capOf(c));
          found.push(c);
        }
        const file = get().file;
        const extracted = { ...file.extracted };
        for (const ch of chunks) extracted[ch.hash] = { model: ai.chatModel, at: Date.now() };
        save({ ...file, extracted, modelConcepts: { ...file.modelConcepts, ...Object.fromEntries(found.map((c) => [c.id, c])) } });
      } catch (e) {
        if (!(e instanceof PreemptedError)) console.warn('concept reading failed', e);
      }
      if (gen !== generation) return;
      set({ reading: { done: (get().reading?.done ?? 0) + 1, total: jobs.length } });
    }
    set({ reading: null });
  };

  /** Questions being phrased right now (so a prefetch and a show don't ask twice). */
  const phrasing = new Set<string>();

  /** A model-phrased question for a level-1+ item, prefetched in the background and cached if it passes. */
  const phrase = async (item: Item, c: Concept) => {
    if (!online() || item.level < 1 || item.format === 'rate' || get().file.bad.includes(item.key)) return;
    const ch = chunkOf(c);
    if (!ch) return;
    const cacheKey = `${item.key}#${c.chunkHash}`;
    const have = get().file.questions[cacheKey] ?? [];
    if (have.length >= 3 || phrasing.has(cacheKey)) return;
    phrasing.add(cacheKey);
    const gen = generation;
    const note = noteOf(c.noteId);
    const level = item.format === 'apply' ? 'apply' : item.format === 'connect' ? 'connect' : 'explain';
    const hint =
      level === 'apply'
        ? LEVEL_HINT.apply(item.source.text.replace(/\*\*|==/g, ''))
        : level === 'connect'
          ? LEVEL_HINT.connect(item.prompt.match(/\*\*([^*]+)\*\*[^*]*\*\*([^*]+)\*\*/)?.[2] ?? '')
          : LEVEL_HINT.explain;
    try {
      const { value } = await chatJSON(
        {
          label: 'Review · writing a question',
          model: useAI.getState().chatModel,
          priority: 'background',
          temperature: 0.3,
          maxTokens: 220,
          schema: SCHEMAS.question,
          messages: [
            { role: 'system', content: MASTERY_ENGINE_PROMPT },
            {
              role: 'user',
              content: questionTask({
                name: c.name,
                level,
                hint,
                avoid: have.map((q) => q.prompt),
                excerpt: { n: 1, where: where(c, note?.meta.title ?? ''), text: ch.text },
              }),
            },
          ],
        },
        (v) => (v && typeof v === 'object' && 'question' in (v as object) ? (v as ModelQuestion) : null),
        parseJSONLoose,
      );
      const ok = validateQuestion(value, item, ch.text, c.name);
      // Not kept if another vault was opened meanwhile.
      if (!ok || gen !== generation) return;
      const file = get().file;
      // Reported while it was being phrased.
      if (file.bad.includes(item.key) || (file.questions[cacheKey] ?? []).some((q) => q.prompt === ok.prompt)) return;
      const list = [...(file.questions[cacheKey] ?? []), { prompt: ok.prompt, points: ok.points ?? [], fact: ok.fact }].slice(-3);
      save({ ...file, questions: { ...file.questions, [cacheKey]: list } });
    } catch {
      /* the item built by code is used */
    } finally {
      phrasing.delete(cacheKey);
    }
  };

  /** The model grades a free answer against the verbatim key points; code checks its evidence. */
  const gradeWithModel = async (item: Item, answer: string): Promise<Grade | null> => {
    if (!online()) return null;
    control?.abort();
    const ctrl = new AbortController();
    control = ctrl;
    try {
      const { value } = await chatJSON(
        {
          label: 'Review · checking your answer',
          model: useAI.getState().chatModel,
          priority: 'interactive',
          temperature: 0,
          maxTokens: 200,
          schema: SCHEMAS.grade,
          signal: ctrl.signal,
          messages: [
            { role: 'system', content: MASTERY_ENGINE_PROMPT },
            { role: 'user', content: gradeTask({ question: item.prompt, points: item.points ?? [item.fact], answer }) },
          ],
        },
        (v) => (Array.isArray((v as GraderReply)?.points) ? (v as GraderReply) : null),
        parseJSONLoose,
      );
      return scoreRubric(value, item.points ?? [item.fact], answer, item.fact, item.prompt);
    } catch {
      return null;
    } finally {
      if (control === ctrl) control = null;
    }
  };

  /**
   * An answer graded the way its item asks: by code first, by the model when
   * code can't tell — null when neither can (the student compares with the
   * notes). `waiting` shows that the model is being asked.
   */
  const gradeAnswer = async (
    item: Item,
    c: Concept,
    answer: string,
    waiting: (ask: () => Promise<Grade | null>) => Promise<Grade | null>,
  ): Promise<{ g: Grade; graded: GradedBy } | null> => {
    if (item.format === 'cloze' || item.format === 'recall') {
      const note = noteOf(c.noteId);
      const g = gradeShort(answer, item.expected ?? '', { accept: item.accept, language: note ? groupOf(note).language : false });
      // A longer typed answer that isn't the exact words may still say it: check it like a free answer — if the
      // hidden words are in it (the line it was shown, typed back, says nothing).
      const keys = [item.expected ?? '', ...(item.accept ?? [])].filter(Boolean);
      if (g.s < 0.8 && contentWords(answer).length > 3 && keys.some((k) => hasKey(answer, k))) {
        const free = quickRubric(answer, [item.fact]) ?? (online() ? await waiting(() => gradeWithModel({ ...item, points: [item.fact] }, answer)) : null);
        if (free && free.s > g.s) return { g: free, graded: 'rubric' };
      }
      return { g, graded: 'typed' };
    }
    // Free answers: code first, the model only when code can't tell.
    const quick = quickRubric(answer, item.points ?? [item.fact]);
    if (quick) return { g: quick, graded: 'rubric' };
    const g = online() ? await waiting(() => gradeWithModel(item, answer)) : null;
    return g ? { g, graded: 'rubric' } : null;
  };

  /** A guiding question after a miss: code's cue at once, the model's (if it passes the checks) a moment later. */
  const nudge = async (item: Item, c: Concept, answer: string) => {
    const f = factOf(item, c);
    const gen = generation;
    const setHint = (h: string) => {
      const cur = get().current;
      if (cur && cur.item.key === item.key && gen === generation) set({ current: { ...cur, hint: h } });
    };
    setHint(hintFor(item, f, true));
    if (!online() || item.format === 'mcq' || isDontKnow(answer)) return;
    try {
      const blanked = f ? (blankOut(f) ?? f.text) : item.fact;
      const { value } = await chatJSON(
        {
          label: 'Review · a hint',
          model: useAI.getState().chatModel,
          priority: 'interactive',
          temperature: 0,
          maxTokens: 60,
          schema: SCHEMAS.nudge,
          messages: [
            { role: 'system', content: MASTERY_ENGINE_PROMPT },
            { role: 'user', content: nudgeTask({ question: item.prompt, blanked, answer }) },
          ],
        },
        (v) => (typeof (v as { nudge?: unknown })?.nudge === 'string' ? (v as { nudge: string }) : null),
        parseJSONLoose,
      );
      const n = value.nudge.trim();
      if (validateNudge(n, { item, blanked, answer, key: f?.key })) setHint(n);
    } catch {
      /* the cue stays */
    }
  };

  // ------------------------------------------------------------ session

  const poolFor = (noteIds: string[]): PoolMeta[] => {
    const out: PoolMeta[] = [];
    for (const id of noteIds) {
      const note = noteOf(id);
      // Deleted or trashed since it was picked.
      if (!note || !isReviewable(note)) continue;
      const g = groupOf(note);
      conceptsOf(note).forEach((c, order) =>
        out.push({
          id: c.id,
          group: g.key,
          groupName: g.name,
          color: g.color,
          chapter: g.chapter,
          noteId: note.meta.id,
          order,
          kind: c.kind,
          exam: !!c.exam,
          cap: c.cap,
          needs: c.needs,
          partners: c.partners,
          name: c.name.replace(/\*\*/g, ''),
          thin: c.thin,
        }),
      );
    }
    return out;
  };

  /** The session's ideas as the notes are now: edits and newly found ideas count, removed ones drop out. */
  const refresh = () => {
    const sess = get().session;
    if (!sess) return;
    const pool = poolFor(sess.noteIds);
    const live = new Set(pool.map((p) => p.id));
    const keep = (id: string) => live.has(id);
    set({ pool, session: { ...sess, working: sess.working.filter(keep), reask: sess.reask.filter((r) => keep(r.c)), needsStudy: sess.needsStudy.filter(keep) } });
  };

  /** Asks the next question, passing over ideas with nothing left to ask; ends the session when none is left. */
  const advance = () => {
    for (;;) {
      const sess = get().session;
      if (!sess) return;
      const id = sess.index >= sess.opts.length ? null : pickNext(sess, get().pool, get().file.states, Date.now(), rng);
      if (!id) return finish();
      if (show(id)) return;
      set({ session: skipConcept(sess, id) });
    }
  };

  /** The item to ask about a concept now, or null when there's none (every one it allows was reported). */
  const buildFor = (c: Concept, st: ConceptState): Item | null => {
    const note = noteOf(c.noteId);
    const meta = get().pool.find((p) => p.id === c.id);
    const siblings = get()
      .pool.filter((p) => p.id !== c.id && p.group === meta?.group && p.kind === c.kind)
      .sort((a, b) => Number(b.chapter === meta?.chapter) - Number(a.chapter === meta?.chapter))
      .map((p) => conceptById(p.id))
      .filter((x): x is Concept => !!x);
    const partners = get()
      .pool.filter((p) => c.partners.includes(p.id))
      .map((p) => conceptById(p.id))
      .filter((x): x is Concept => !!x);
    const ch = chunkOf(c);
    // The grounding invariant can't be checked without the passage.
    if (!ch) return null;
    const asked = get().session?.history.filter((h) => h.c === c.id).map((h) => h.key) ?? [];
    const bad = get().file.bad;
    const avoid = [...asked, ...st.recent.map((r) => r.key), ...bad];
    const ctx = {
      title: note?.meta.title ?? '',
      siblings: [...siblings, ...partners],
      avoid,
      exclude: bad,
      rng,
      languageClass: note ? groupOf(note).language : false,
      firstExposure: !st.attempts,
      chunkText: ch.text,
    };
    let item = buildItem(c, st.level, ctx);
    // A reported item is never asked again (in any phrasing): one a rung lower instead.
    for (let lvl = Math.min(st.level, c.cap) - 1; bad.includes(item.key) && lvl >= 0; lvl--) item = buildItem(c, lvl as Level, ctx);
    if (bad.includes(item.key)) return null;
    // A cached question the model phrased (and the checks passed).
    const cached = get().file.questions[`${item.key}#${c.chunkHash}`];
    if (cached?.length && item.level >= 1) {
      const q = cached[st.attempts % cached.length];
      item = { ...item, prompt: q.prompt, points: q.points.length ? q.points : item.points, fact: q.fact, origin: 'model' };
    }
    // The grounding invariant: never show an item whose answer isn't the note's own text.
    const siblingTexts = ctx.siblings.flatMap((s) => s.facts.map((f) => f.text));
    if (!assertGroundedItem(item, ch.text, siblingTexts)) {
      console.warn('review item dropped (not grounded)', item.key);
      item = buildItem(c, 0, { ...ctx, firstExposure: false });
      if (bad.includes(item.key) || !assertGroundedItem(item, ch.text, siblingTexts)) return null;
    }
    return item;
  };

  /** Shows a concept's next question; false when it has none left to ask. */
  const show = (conceptIdToAsk: string): boolean => {
    const c = conceptById(conceptIdToAsk);
    const sess = get().session;
    if (!c || !sess) return false;
    const now = Date.now();
    const st = get().file.states[c.id] ?? freshState(now);
    const item = buildFor(c, st);
    if (!item) return false;
    set({
      current: {
        item,
        concept: c,
        phase: 'ask',
        hintUsed: false,
        revealed: false,
        firstInSession: !sess.asked.includes(c.id),
        // Learned before and not being learned in this session: a review (one question; right means done for today).
        wasDue: !!st.attempts && !sess.working.includes(c.id),
        stateBefore: st,
        shownAt: now,
      },
    });
    // Prefetch the next likely question's phrasing while the student thinks.
    const peek = pickNext({ ...sess, history: [...sess.history, { c: c.id, key: item.key, group: '', s: 1, conf: null, at: now }] }, get().pool, get().file.states, now, mulberry32(sess.seed + sess.index + 1));
    const nc = peek ? conceptById(peek) : null;
    if (nc) {
      const nst = get().file.states[nc.id] ?? freshState(now);
      const upcoming = nst.level >= 1 ? buildFor(nc, nst) : null;
      if (upcoming) void phrase(upcoming, nc);
    }
    if (item.level >= 1 && item.origin === 'template') void phrase(item, c);
    return true;
  };

  /** The misconceptions without the one this answer added. */
  const withoutMisconception = (cur: Current) => {
    const list = get().misconceptions;
    const last = list.at(-1);
    return cur.feedback?.hypercorrect && last?.conceptId === cur.concept.id ? list.slice(0, -1) : list;
  };

  const apply = (g: Grade, graded: Item['graded']) => {
    const cur = get().current;
    const sess = get().session;
    if (!cur || !sess) return;
    const now = Date.now();
    const c = cur.concept;
    // The session's own entry for the concept, so mastery is judged the same way here and in the scheduler.
    const meta = get().pool.find((p) => p.id === c.id);
    if (!meta) return;
    const conf = cur.conf ?? null;
    // Naming the idea an example shows is incomplete, not a mix-up: it isn't kept as a misconception. Nor is
    // "I don't know", typed while "Sure" was on.
    const named = !!cur.dontKnow || (!!cur.answer && namesPoint(cur.answer, cur.item.points ?? []));
    const answer = { s: g.s, graded, level: cur.item.level, key: cur.item.key, conf, hint: cur.hintUsed, answer: named ? undefined : cur.answer, firstInSession: cur.firstInSession };
    const after = recordAnswer(cur.stateBefore, answer, meta.cap, now, meta.needs);
    const mastered = isMastered(after, meta.cap, meta.needs);
    const file = get().file;
    save({ ...file, states: { ...file.states, [c.id]: after } });
    const verdict = verdictOf(g.s);
    const missed = cur.item.points?.filter((p) => verdict !== 'right' && !(cur.answer && covers(cur.answer, p)));
    const hypercorrect = verdict === 'wrong' && conf === 'sure' && !named;
    if (hypercorrect && cur.answer) set({ misconceptions: [...get().misconceptions, { conceptId: c.id, wrote: cur.answer.slice(0, 80), notesSay: cur.item.fact }] });
    // Right after a hint counts as partly known: it comes back later in the session, without one.
    const hinted = cur.hintUsed && verdict === 'right';
    set({
      session: requeue(sess, meta, { key: cur.item.key, s: scoreOf(answer), conf, mastered, wasDue: cur.wasDue }, now),
      current: {
        ...cur,
        sessBefore: sess,
        phase: 'feedback',
        feedback: {
          s: g.s,
          verdict,
          note: g.note ?? (hinted ? 'With a hint — it comes back later without one.' : undefined),
          missed,
          hypercorrect,
          lucky: verdict === 'right' && conf === 'guess',
          before: Math.round(cur.stateBefore.p * 100),
          after: Math.round(after.p * 100),
          mastered,
        },
      },
    });
    if (verdict !== 'right') void nudge(cur.item, c, cur.answer ?? '');
  };

  /** Sums the session up; `stopped` when the student ended it. */
  const finish = (stopped = false) => {
    const sess = get().session;
    if (!sess) return;
    // Nothing was asked (nothing due or new): no session to sum up or keep.
    if (!sess.history.length) {
      control?.abort();
      set({ session: null, current: null });
      return;
    }
    const now = Date.now();
    const pool = get().pool;
    const startStates = get().startStates;
    const notes = useVault.getState();
    const tree = buildReviewTree(notes.notes, notes.folders, notes.folderMeta);
    const summary = summarize(
      sess,
      pool,
      startStates,
      get().file.states,
      {
        label: selectionLabel(tree, new Set(sess.noteIds)),
        notReviewable: sess.noteIds.flatMap((id) => (noteOf(id) ? notReviewable(noteOf(id)!).map((s) => `${noteOf(id)!.meta.title} › ${s}`) : [])),
        misconceptions: get().misconceptions,
        overrides: get().overrides,
        stopped,
      },
      now,
    );
    const file = get().file;
    save({ ...file, sessions: [summary, ...file.sessions].slice(0, 30) });
    control?.abort();
    set({ session: null, current: null, summary });
    flushReview();
  };

  return {
    loaded: false,
    file: EMPTY,
    selection: [],
    opts: { length: 15, mix: true, askConfidence: true },
    reading: null,
    session: null,
    pool: [],
    current: null,
    summary: null,
    overrides: 0,
    misconceptions: [],
    startStates: {},

    load() {
      const backend = useVault.getState().backend;
      // Once per vault: a second call while it's read waits for the same read.
      if (backend === loadedFor && (get().loaded || pendingRead)) return pendingRead ?? Promise.resolve();
      // Another vault: what's pending is saved to the vault it belongs to, and nothing of it carries over
      // (its session, its picks, a model job still running).
      if (loadedFor && loadedFor !== backend) {
        flushReview();
        scheduleExtract.cancel();
        control?.abort();
        set({ session: null, current: null, pool: [], summary: null, selection: [], reading: null, overrides: 0, misconceptions: [], startStates: {} });
      }
      const gen = ++generation;
      loadedFor = backend;
      readOnly = false;
      dirty = false;
      set({ loaded: false, file: EMPTY });
      const read = readFile(backend).then(({ file, writable }) => {
        if (gen !== generation) return;
        readOnly = !writable;
        const vault = useVault.getState();
        set({ file: vault.ready && vault.backend === backend ? pruneFile(file, vault.notes) : file, loaded: true });
      });
      pendingRead = read.finally(() => {
        if (gen === generation) pendingRead = null;
      });
      return pendingRead;
    },

    readMore: extract,

    setSelection(ids) {
      set({ selection: ids });
      scheduleExtract(ids);
    },

    request(ids) {
      if (get().session) get().end();
      // A summary already on screen was seen: it makes way.
      else if (get().summary) get().closeSummary();
      get().setSelection(ids);
    },

    setOpts(p) {
      set({ opts: { ...get().opts, ...p } });
    },

    start(noteIds = get().selection) {
      if (!noteIds.length) return;
      const now = Date.now();
      const seed = Math.floor(Math.random() * 2 ** 31);
      rng = mulberry32(seed);
      const pool = poolFor(noteIds);
      const groups = new Set(pool.map((p) => p.group));
      const opts = { ...get().opts, mix: get().opts.mix && groups.size > 1 };
      const session = newSession(uid('rs'), seed, noteIds, opts, now);
      const startStates: Record<string, ConceptState | undefined> = {};
      for (const p of pool) startStates[p.id] = get().file.states[p.id];
      set({ session, pool, summary: null, current: null, overrides: 0, misconceptions: [], startStates, selection: noteIds });
      advance();
    },

    setConf(conf) {
      const cur = get().current;
      if (cur && cur.phase === 'ask') set({ current: { ...cur, conf } });
    },

    async submit(answer, conf) {
      const cur = get().current;
      if (!cur || cur.phase !== 'ask') return;
      const item = cur.item;
      // A self-check has no written answer: the student compares the one in their head.
      if (item.format === 'rate') {
        set({ current: { ...cur, answer: undefined, conf, phase: 'self', revealed: true } });
        return;
      }
      if (isDontKnow(answer)) {
        set({ current: { ...cur, answer, conf, dontKnow: true } });
        apply({ s: 0 }, item.graded);
        get().reveal();
        return;
      }
      set({ current: { ...cur, answer, conf } });
      const r = await gradeAnswer(item, cur.concept, answer, withGrading);
      // Moved on (or the session ended) while the model was checking.
      const now = get().current;
      if (!now || now.shownAt !== cur.shownAt) return;
      if (r) apply(r.g, r.graded);
      // No model (or no valid verdict): the student compares with the notes.
      else set({ current: { ...now, phase: 'self', revealed: true } });
    },

    choose(index, conf) {
      const cur = get().current;
      if (!cur || cur.phase !== 'ask' || cur.item.format !== 'mcq') return;
      set({ current: { ...cur, choice: index, conf, answer: cur.item.choices?.[index] } });
      apply({ s: index === cur.item.correct ? 1 : 0 }, 'mcq');
    },

    dontKnow() {
      const cur = get().current;
      if (!cur || cur.phase !== 'ask') return;
      set({ current: { ...cur, answer: '', conf: null, dontKnow: true } });
      apply({ s: 0 }, cur.item.graded);
      // Nothing to retry from: show the notes' answer straight away (a re-teach).
      get().reveal();
    },

    selfGrade(s) {
      const cur = get().current;
      if (!cur || cur.phase !== 'self') return;
      set({ current: { ...cur, selfGraded: true } });
      apply({ s }, 'self');
    },

    showHint() {
      const cur = get().current;
      if (!cur || cur.phase !== 'ask') return;
      set({ current: { ...cur, hintUsed: true, hint: hintFor(cur.item, factOf(cur.item, cur.concept)) } });
    },

    async retry(answer) {
      const cur = get().current;
      if (!cur || cur.phase !== 'feedback' || cur.retry || cur.item.format === 'mcq' || cur.item.format === 'rate') return;
      // Still this question (the student may move on while the model checks).
      const same = () => {
        const now = get().current;
        return now && now.shownAt === cur.shownAt && now.item.key === cur.item.key ? now : null;
      };
      // Graded like a first answer, but not counted.
      const r = await gradeAnswer(cur.item, cur.concept, answer, (ask) => {
        const now = same();
        if (now) set({ current: { ...now, retry: { answer, checking: true } } });
        return ask();
      });
      const now = same();
      if (!now) return;
      // The next update learns more for having been re-taught.
      const file = get().file;
      const st = file.states[cur.concept.id];
      if (st) save({ ...file, states: { ...file.states, [cur.concept.id]: { ...st, retaught: true } } });
      // Undecided (no model): the notes are shown to compare with.
      set({ current: { ...now, retry: { answer, s: r?.g.s }, revealed: true } });
    },

    reveal() {
      const cur = get().current;
      if (!cur) return;
      const file = get().file;
      const st = file.states[cur.concept.id];
      if (st && cur.feedback && cur.feedback.verdict !== 'right') save({ ...file, states: { ...file.states, [cur.concept.id]: { ...st, retaught: true } } });
      set({ current: { ...cur, revealed: true } });
    },

    next() {
      if (!get().session) return;
      refresh();
      advance();
    },

    override() {
      const cur = get().current;
      const sess = get().session;
      if (!cur || !sess || cur.phase !== 'feedback' || cur.overridden || get().overrides >= 3 || cur.feedback?.verdict === 'right') return;
      // Only an answer that was written, and graded by someone else, can have been right.
      if (!canOverride(cur)) return;
      const meta = get().pool.find((p) => p.id === cur.concept.id);
      if (!meta || !cur.sessBefore) return;
      const now = Date.now();
      const c = cur.concept;
      const s = Math.max(cur.feedback?.s ?? 0, 0.8);
      const answer = { s, graded: 'self' as const, level: cur.item.level, key: cur.item.key, conf: cur.conf ?? null, hint: cur.hintUsed, answer: cur.answer, firstInSession: cur.firstInSession };
      const after = recordAnswer(cur.stateBefore, answer, meta.cap, now, meta.needs);
      const mastered = isMastered(after, meta.cap, meta.needs);
      const file = get().file;
      save({ ...file, states: { ...file.states, [c.id]: after } });
      // The session counts the answer again, as right: no re-ask, not a miss, out of the working set once mastered.
      set({
        overrides: get().overrides + 1,
        misconceptions: withoutMisconception(cur),
        session: requeue(cur.sessBefore, meta, { key: cur.item.key, s: scoreOf(answer), conf: answer.conf, mastered, wasDue: cur.wasDue }, now),
        current: { ...cur, overridden: true, feedback: { ...cur.feedback!, s, verdict: 'right', hypercorrect: false, after: Math.round(after.p * 100), mastered } },
      });
    },

    report() {
      const cur = get().current;
      if (!cur) return;
      const file = get().file;
      const { [`${cur.item.key}#${cur.concept.chunkHash}`]: _phrasings, ...questions } = file.questions;
      const { [cur.concept.id]: _counted, ...states } = file.states;
      // The answer doesn't count, and the item isn't asked again in any phrasing.
      save({ ...file, bad: [...new Set([...file.bad, cur.item.key])], questions, states: cur.stateBefore.attempts ? { ...states, [cur.concept.id]: cur.stateBefore } : states });
      if (cur.sessBefore) set({ session: cur.sessBefore, misconceptions: withoutMisconception(cur), overrides: get().overrides - (cur.overridden ? 1 : 0) });
      get().next();
    },

    unreport(key) {
      const file = get().file;
      if (file.bad.includes(key)) save({ ...file, bad: file.bad.filter((k) => k !== key) });
    },

    end() {
      if (get().session?.history.length) finish(true);
      else {
        control?.abort();
        set({ session: null, current: null });
      }
    },

    closeSummary() {
      set({ summary: null });
    },
  };

  async function withGrading<T>(fn: () => Promise<T>): Promise<T> {
    const cur = get().current;
    if (cur) set({ current: { ...cur, phase: 'grading' } });
    try {
      return await fn();
    } finally {
      const now = get().current;
      if (now && now.phase === 'grading') set({ current: { ...now, phase: 'ask' } });
    }
  }
});

/** Reading for more concepts starts once the picked notes have stayed the same for a moment. */
const scheduleExtract = debounce((ids: string[]) => {
  void useReview
    .getState()
    .load()
    .then(() => useReview.getState().readMore(ids));
}, 1500);

function jaccard(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

