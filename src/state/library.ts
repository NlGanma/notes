import { create } from 'zustand';
import { buildBm25, chunkVault, decodeVector, encodeVector, rankChunks, tokenize, type Chunk, type Hit, type Scope } from '../lib/ai/rag';
import { calibrateSemantic, idfOf, type SemanticCalib, type VaultStats } from '../lib/ai/policy';
import { embed } from '../lib/ai/providers';
import { providerConfig, useAI } from './ai';
import { useVault } from './vault';
import { debounce } from '../lib/util';

/**
 * The library index: section chunks of every note plus (optional) local
 * embeddings, cached in the vault (`.nib/embeddings.json`) so they are only
 * computed once per passage.
 */

interface IndexState {
  vectors: Map<string, Float32Array>;
  model: string;
  loaded: boolean;
  status: 'idle' | 'indexing' | 'error';
  done: number;
  total: number;
  error: string | null;
  load(): Promise<void>;
  ensure(): Promise<void>;
}

let saving = false;
const persistVectors = debounce(async () => {
  const { vectors, model } = useLibrary.getState();
  const backend = useVault.getState().backend;
  if (!backend || saving) return;
  saving = true;
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of vectors) obj[k] = encodeVector(Array.from(v));
    await backend.writeKV('embeddings', JSON.stringify({ model, vectors: obj }));
  } finally {
    saving = false;
  }
}, 1500);

export const useLibrary = create<IndexState>((set, get) => ({
  vectors: new Map(),
  model: '',
  loaded: false,
  status: 'idle',
  done: 0,
  total: 0,
  error: null,

  async load() {
    if (get().loaded) return;
    const backend = useVault.getState().backend;
    if (!backend) return;
    try {
      const raw = await backend.readKV('embeddings');
      if (raw) {
        const parsed = JSON.parse(raw) as { model: string; vectors: Record<string, string> };
        const vectors = new Map<string, Float32Array>();
        for (const [k, v] of Object.entries(parsed.vectors ?? {})) vectors.set(k, decodeVector(v));
        set({ vectors, model: parsed.model ?? '' });
      }
    } catch {
      /* start fresh */
    }
    set({ loaded: true });
  },

  async ensure() {
    const ai = useAI.getState();
    await get().load();
    if (!ai.embedModel || ai.status !== 'online' || get().status === 'indexing') return;
    if (get().model && get().model !== ai.embedModel) set({ vectors: new Map(), model: ai.embedModel });
    if (!get().model) set({ model: ai.embedModel });
    const chunks = chunkVault(Object.values(useVault.getState().notes));
    const missing = chunks.filter((c) => !get().vectors.has(c.hash));
    set({ total: chunks.length, done: chunks.length - missing.length });
    if (!missing.length) return;
    set({ status: 'indexing', error: null });
    try {
      for (let i = 0; i < missing.length; i += 16) {
        const batch = missing.slice(i, i + 16);
        const vecs = await embed(providerConfig(), ai.embedModel, batch.map(embedText));
        const vectors = new Map(get().vectors);
        batch.forEach((c, j) => vecs[j] && vectors.set(c.hash, new Float32Array(vecs[j])));
        set({ vectors, done: get().done + batch.length });
        persistVectors();
      }
      set({ status: 'idle' });
    } catch (e) {
      set({ status: 'error', error: String((e as Error).message ?? e) });
    }
  },
}));

const embedText = (c: Chunk) => `${c.title}${c.section ? ` — ${c.section}` : ''}\n${c.text}`.slice(0, 2000);

/** Hybrid search across the vault (used by Ask your notes and Quick Open). */
export async function searchLibrary(query: string, scope: Scope = { kind: 'all' }, k = 6): Promise<Hit[]> {
  const notes = Object.values(useVault.getState().notes);
  const chunks = chunkVault(notes, scope);
  const ai = useAI.getState();
  const lib = useLibrary.getState();
  let queryVector: number[] | null = null;
  if (ai.embedModel && ai.status === 'online') {
    void lib.ensure();
    try {
      [queryVector] = await embed(providerConfig(), ai.embedModel, [query]);
    } catch {
      queryVector = null;
    }
  }
  return rankChunks(chunks, query, { vectors: useLibrary.getState().vectors, queryVector, k, index: buildBm25(chunks) });
}

/** Synchronous keyword-only search (instant results while typing). */
export function keywordSearch(query: string, k = 8): Hit[] {
  // Quick Open searches everything, homework included.
  const notes = Object.values(useVault.getState().notes);
  const chunks = chunkVault(notes, { kind: 'notes', ids: notes.map((n) => n.meta.id) });
  return rankChunks(chunks, query, { k });
}

/**
 * A broad, even sample of the passages in scope (round-robin across notes) —
 * used by study tools so a study guide or flashcards cover everything, not
 * just what matches a keyword.
 */
export function sampleLibrary(scope: Scope = { kind: 'all' }, k = 12): Hit[] {
  const notes = Object.values(useVault.getState().notes).filter((n) => scope.kind !== 'all' || !n.meta.tags.includes('guide'));
  const chunks = chunkVault(notes, scope).filter((c) => c.text.length > 60);
  const byNote = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const list = byNote.get(c.noteId) ?? [];
    list.push(c);
    byNote.set(c.noteId, list);
  }
  const out: Hit[] = [];
  const queues = [...byNote.values()];
  for (let round = 0; out.length < k && queues.some((q) => q.length > round); round++) {
    for (const q of queues) {
      if (q[round] && out.length < k) out.push({ chunk: q[round], score: 0, keyword: 0, semantic: null });
    }
  }
  return out;
}

// ------------------------------------------------------------------ grounding statistics

let statsCache: { notes: unknown; stats: VaultStats; inVault: (t: string) => boolean } | null = null;

/**
 * Word statistics over every passage in the vault (IDF for the notes-only
 * check and the coverage gate). Recomputed only when the notes change.
 */
export function vaultStats(): { stats: VaultStats; idf: (t: string) => number; inVault: (t: string) => boolean } {
  const notes = useVault.getState().notes;
  if (!statsCache || statsCache.notes !== notes) {
    // Class material only: homework and AI-written notes must not make a word count as "in the notes".
    const chunks = chunkVault(Object.values(notes), { kind: 'all' });
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of new Set(tokenize(`${c.title} ${c.section} ${c.text}`))) df.set(t, (df.get(t) ?? 0) + 1);
    const prefixes = new Set([...df.keys()].filter((t) => t.length >= 6).map((t) => t.slice(0, 5)));
    statsCache = { notes, stats: { N: chunks.length, df }, inVault: (t) => df.has(t) || (t.length >= 6 && prefixes.has(t.slice(0, 5))) };
  }
  return { stats: statsCache.stats, idf: idfOf(statsCache.stats), inVault: statsCache.inVault };
}

let calibCache: { size: number; model: string; calib: SemanticCalib | null } | null = null;

/** How similar unrelated passages are under the current embedding model (for the coverage gate). */
export function semanticCalib(): SemanticCalib | null {
  const { vectors, model } = useLibrary.getState();
  if (!calibCache || calibCache.size !== vectors.size || calibCache.model !== model)
    calibCache = { size: vectors.size, model, calib: calibrateSemantic([...vectors.values()]) };
  return calibCache.calib;
}
