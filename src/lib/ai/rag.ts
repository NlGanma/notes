import type { NoteDoc } from '../vault/types';
import { docBlocks } from './context';
import { hashString } from '../util';

/**
 * Retrieval over the whole vault ("Ask your notes").
 *
 * Notes are split into section-sized chunks. Retrieval is hybrid: BM25
 * keyword search always works (no extra model needed); when an embedding
 * model is configured, cosine similarity on local embeddings is fused in with
 * reciprocal-rank fusion.
 */

export interface Chunk {
  id: string;
  noteId: string;
  title: string;
  folder: string;
  section: string;
  text: string;
  blockIds: string[];
  hash: string;
}

export type Scope =
  | { kind: 'all' }
  | { kind: 'folder'; path: string }
  | { kind: 'note'; id: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'notes'; ids: string[] };

const MAX_CHARS = 900;

export function chunkNote(note: NoteDoc): Chunk[] {
  const blocks = docBlocks(note.content, { sourcesOnly: true });
  const chunks: Chunk[] = [];
  let cur: { section: string; parts: string[]; ids: string[] } | null = null;
  const title = note.meta.title || 'Untitled';
  const flush = () => {
    if (!cur || !cur.parts.join('').trim()) return;
    const text = cur.parts.join('\n');
    chunks.push({
      id: `${note.meta.id}#${chunks.length}`,
      noteId: note.meta.id,
      title,
      folder: note.meta.folder,
      section: cur.section,
      text,
      blockIds: cur.ids.filter(Boolean),
      hash: hashString(`${title}\n${cur.section}\n${text}`),
    });
  };
  for (const b of blocks) {
    const startNew = !cur || b.type === 'heading' || cur.parts.join('\n').length + b.text.length > MAX_CHARS;
    if (startNew) {
      flush();
      cur = { section: b.section, parts: [], ids: [] };
    }
    cur!.parts.push(b.text);
    cur!.ids.push(b.id);
  }
  flush();
  return chunks;
}

export function chunkVault(notes: NoteDoc[], scope: Scope = { kind: 'all' }): Chunk[] {
  const inScope = notes.filter((n) => {
    if (n.meta.trashed) return false;
    // Homework holds the student's questions, not class material — only searched when picked explicitly.
    if (n.meta.homework && scope.kind !== 'note' && scope.kind !== 'notes') return false;
    switch (scope.kind) {
      case 'all':
        return true;
      case 'folder':
        return n.meta.folder === scope.path || n.meta.folder.startsWith(scope.path + '/');
      case 'note':
        return n.meta.id === scope.id;
      case 'tag':
        return n.meta.tags.includes(scope.tag);
      case 'notes':
        return scope.ids.includes(n.meta.id);
    }
  });
  return inScope.flatMap(chunkNote);
}

// ------------------------------------------------------------------ BM25

const STOP = new Set(
  'a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when where which who why will with you your do does did can could would should about how not no yes also just more most very'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (let w of text
    .toLowerCase()
    .replace(/\\([a-z]+)/g, ' $1 ')
    .split(/[^a-z0-9α-ωθ]+/)) {
    if (!w || STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
    // Light stemming so "limits" matches "limit" and "derivatives" matches "derivative".
    if (w.length > 5 && /(ations?|ings?|edly|ed|ly)$/.test(w)) w = w.replace(/(ations?|ings?|edly|ed|ly)$/, '');
    else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

export interface Bm25Index {
  docs: { tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avg: number;
}

export function buildBm25(chunks: Chunk[]): Bm25Index {
  const df = new Map<string, number>();
  const docs = chunks.map((c) => {
    const toks = tokenize(`${c.title} ${c.title} ${c.section} ${c.text}`);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { tf, len: toks.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avg };
}

export function bm25Scores(index: Bm25Index, query: string, k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  const N = index.docs.length;
  return index.docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (index.avg || 1)));
    }
    return s;
  });
}

// ------------------------------------------------------------------ vectors

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

export function encodeVector(v: number[]): string {
  const f = new Float32Array(v);
  const bytes = new Uint8Array(f.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decodeVector(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ------------------------------------------------------------------ fusion

export interface Hit {
  chunk: Chunk;
  score: number;
  keyword: number;
  semantic: number | null;
}

export function rankChunks(
  chunks: Chunk[],
  query: string,
  opts: { vectors?: Map<string, Float32Array>; queryVector?: number[] | null; k?: number; index?: Bm25Index } = {},
): Hit[] {
  if (!chunks.length) return [];
  const k = opts.k ?? 6;
  const index = opts.index ?? buildBm25(chunks);
  const kw = bm25Scores(index, query);
  const kwRank = rankOf(kw);
  let sem: (number | null)[] = chunks.map(() => null);
  let semRank: number[] | null = null;
  if (opts.queryVector && opts.vectors) {
    sem = chunks.map((c) => {
      const v = opts.vectors!.get(c.hash);
      return v ? cosine(opts.queryVector!, v) : null;
    });
    semRank = rankOf(sem.map((s) => (s === null ? -Infinity : s)));
  }
  const hits: Hit[] = chunks.map((chunk, i) => {
    let score = 0;
    if (kw[i] > 0) score += 1 / (50 + kwRank[i]);
    if (semRank && sem[i] !== null && (sem[i] as number) > 0.2) score += 1.15 / (50 + semRank[i]);
    return { chunk, score, keyword: kw[i], semantic: sem[i] };
  });
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function rankOf(scores: number[]): number[] {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  const rank = new Array<number>(scores.length);
  order.forEach(([, i], r) => (rank[i] = r));
  return rank;
}

export function formatExcerpts(hits: Hit[]): string {
  return hits
    .map((h, i) => {
      const where = [h.chunk.folder, `"${h.chunk.title}"`, h.chunk.section].filter(Boolean).join(' › ');
      return `[${i + 1}] (${where})\n${h.chunk.text.trim()}`;
    })
    .join('\n\n');
}

/** Short snippet around the best-matching words, for search results. */
export function snippet(text: string, query: string, len = 160): string {
  const q = tokenize(query);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of q) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const clean = (s: string) =>
    s
      .replace(/[*=`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  if (at < 0) return clean(text.slice(0, len));
  const start = Math.max(0, at - len / 3);
  return (start > 0 ? '…' : '') + clean(text.slice(start, start + len)) + (start + len < text.length ? '…' : '');
}
