import { LIBRARY_KEY, useAssistant, type ChatMsg, type Thread } from '../../state/assistant';
import type { Scope } from '../../lib/ai/rag';
import { STUDY_TOOLS } from '../../lib/ai/prompts';
import { uid } from '../../lib/util';

/*
 * Ask your notes keeps one live conversation under LIBRARY_KEY, which every assistant action works on.
 * Earlier ones are parked beside it as "library:<id>" threads (so they persist with the rest), and
 * History swaps one back in.
 */

const PREFIX = `${LIBRARY_KEY}:`;
// Each answer carries the passages it cites, and all of it lives in localStorage: keep the history short.
const KEEP = 10;

export interface PastConversation {
  key: string;
  title: string;
  at: number;
}

/** A conversation's name: its first question (or the study tool it started with). */
export function conversationTitle(messages: ChatMsg[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New conversation';
  if (first.tool) return first.focus ? `${STUDY_TOOLS[first.tool].label}: ${first.focus}` : STUDY_TOOLS[first.tool].label;
  return (first.label ?? first.content).replace(/\s+/g, ' ').trim() || 'Untitled conversation';
}

export function pastConversations(threads: Record<string, Thread>): PastConversation[] {
  return Object.entries(threads)
    .filter(([k, t]) => k.startsWith(PREFIX) && t.messages.length)
    .map(([key, t]) => ({ key, title: conversationTitle(t.messages), at: t.messages.at(-1)!.at }))
    .sort((a, b) => b.at - a.at);
}

/** A reply cut short by the swap reads as stopped, not as still coming. */
const settled = (messages: ChatMsg[]) => messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' as const, phase: undefined } : m));

/** Parks the live conversation (if it has anything in it) in `threads`, keeping the newest few. */
function park(threads: Record<string, Thread>) {
  const live = threads[LIBRARY_KEY];
  delete threads[LIBRARY_KEY];
  if (live?.messages.length) {
    const key = PREFIX + uid();
    threads[key] = { key, messages: settled(live.messages) };
  }
  const old = Object.keys(threads)
    .filter((k) => k.startsWith(PREFIX))
    .sort((a, b) => (threads[b].messages.at(-1)?.at ?? 0) - (threads[a].messages.at(-1)?.at ?? 0))
    .slice(KEEP);
  for (const k of old) delete threads[k];
}

/** New conversation: the current one moves to History. */
export function startConversation() {
  const s = useAssistant.getState();
  if (s.streaming === LIBRARY_KEY) s.stop();
  const threads = { ...s.threads };
  park(threads);
  useAssistant.setState({ threads });
}

/** The notes a conversation was last asked about. */
export function scopeOf(messages: ChatMsg[]): Scope | undefined {
  return [...messages].reverse().find((m) => m.role === 'user' && m.scope)?.scope;
}

export function sameScope(a: Scope | undefined, b: Scope | undefined): boolean {
  if (!a || !b) return a === b;
  const norm = (s: Scope) => (s.kind === 'notes' ? { kind: 'notes', ids: [...s.ids].sort() } : s);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * Before the Ask page opens on `scope` from somewhere else: a conversation about other notes (or any
 * conversation, when `fresh`) moves to History, so a question asked from a class page or Review never
 * lands in it, or sends it to the model.
 */
export function conversationFor(scope: Scope | undefined, fresh = false) {
  const live = useAssistant.getState().threads[LIBRARY_KEY]?.messages;
  if (!live?.length) return;
  if (fresh || (scope && !sameScope(scopeOf(live), scope))) startConversation();
}

/** Brings a past conversation back (the current one takes its place in History). Returns the scope it was asked in. */
export function reopenConversation(key: string): Scope | undefined {
  const s = useAssistant.getState();
  const past = s.threads[key];
  if (!past) return undefined;
  if (s.streaming === LIBRARY_KEY) s.stop();
  const threads = { ...s.threads };
  delete threads[key];
  park(threads);
  threads[LIBRARY_KEY] = { key: LIBRARY_KEY, messages: past.messages };
  useAssistant.setState({ threads });
  return scopeOf(past.messages);
}

/** Deletes a conversation (the live one, or one in History). Returns what puts it back. */
export function deleteConversation(key: string): () => void {
  const s = useAssistant.getState();
  const gone = s.threads[key];
  if (!gone) return () => {};
  if (key === LIBRARY_KEY && s.streaming === LIBRARY_KEY) s.stop();
  const threads = { ...s.threads };
  delete threads[key];
  useAssistant.setState({ threads });
  return () => {
    const now = { ...useAssistant.getState().threads };
    // The page may have a new conversation by now: the deleted one comes back in History instead.
    const into = key === LIBRARY_KEY && now[LIBRARY_KEY]?.messages.length ? PREFIX + uid() : key;
    now[into] = { key: into, messages: settled(gone.messages) };
    useAssistant.setState({ threads: now });
  };
}
