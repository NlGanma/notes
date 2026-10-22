import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FilePlus2, RotateCcw, Shuffle, X } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { parseJSONLoose } from '../../lib/ai/actions';
import { renderMarkdown } from '../../lib/ai/markdown';
import type { SourceRef } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';

export interface Card {
  front: string;
  back: string;
  source?: number;
}

export interface QuizQ {
  q: string;
  choices: string[];
  answer: number;
  explain?: string;
  source?: number;
}

export function parseStudyJSON(tool: string, text: string): { kind: 'flashcards'; cards: Card[] } | { kind: 'quiz'; questions: QuizQ[] } | null {
  const obj = parseJSONLoose<Record<string, unknown>>(text);
  if (!obj) return null;
  if (tool === 'flashcards') {
    const raw = (Array.isArray(obj) ? obj : (obj.cards as unknown[])) ?? [];
    const cards = (raw as Record<string, unknown>[])
      .map((c) => ({ front: String(c.front ?? c.q ?? c.question ?? ''), back: String(c.back ?? c.a ?? c.answer ?? ''), source: Number(c.source) || undefined }))
      .filter((c) => c.front && c.back);
    return cards.length ? { kind: 'flashcards', cards } : null;
  }
  const raw = (Array.isArray(obj) ? obj : (obj.questions as unknown[])) ?? [];
  const questions = (raw as Record<string, unknown>[])
    .map((q) => ({
      q: String(q.q ?? q.question ?? ''),
      choices: Array.isArray(q.choices) ? (q.choices as unknown[]).map(String).slice(0, 5) : [],
      answer:
        typeof q.answer === 'number'
          ? q.answer
          : Math.max(
              0,
              ['a', 'b', 'c', 'd', 'e'].indexOf(
                String(q.answer ?? '')
                  .toLowerCase()
                  .slice(0, 1),
              ),
            ),
      explain: q.explain ? String(q.explain) : undefined,
      source: Number(q.source) || undefined,
    }))
    .filter((q) => q.q && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length);
  return questions.length ? { kind: 'quiz', questions } : null;
}

const md = (s: string) => renderMarkdown(s);

function SourceLink({ n, sources, onOpen }: { n?: number; sources: SourceRef[]; onOpen(s: SourceRef): void }) {
  const src = sources.find((s) => s.n === n);
  if (!src) return null;
  return (
    <button
      className="study-source"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(src);
      }}
    >
      <span className="cite-n">{src.n}</span> {src.title}
      {src.section ? ` › ${src.section}` : ''}
    </button>
  );
}

export function Flashcards({ cards: initial, sources, onOpen }: { cards: Card[]; sources: SourceRef[]; onOpen(s: SourceRef): void }) {
  const [cards, setCards] = useState(initial);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const card = cards[i];
  const go = (d: number) => {
    setFlipped(false);
    setI((v) => (v + d + cards.length) % cards.length);
  };

  const save = () => {
    const content: JSONContent[] = [];
    for (const c of cards) {
      content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: c.front.replace(/\$/g, '') }] });
      content.push({ type: 'paragraph', content: [{ type: 'text', text: c.back }] });
    }
    const doc = useVault.getState().createNote({ title: 'Flashcards', tags: ['flashcards'], content: { type: 'doc', content } });
    useUI.getState().openNote(doc.meta.id, { newTab: true });
  };

  return (
    <div className="flashcards">
      <div className="fc-head">
        <span className="fc-count">
          Card {i + 1} of {cards.length}
        </span>
        <span className="fc-known">{known.size} known</span>
        <span className="grow" />
        <button
          className="icon-btn is-tiny"
          title="Shuffle"
          onClick={() => {
            setCards((c) => [...c].sort(() => Math.random() - 0.5));
            setI(0);
            setFlipped(false);
          }}
        >
          <Shuffle size={14} />
        </button>
        <button className="icon-btn is-tiny" title="Save as a note" onClick={save}>
          <FilePlus2 size={14} />
        </button>
      </div>
      <div
        className={cx('fc-card', flipped && 'is-flipped')}
        onClick={() => setFlipped((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === ' ' && setFlipped((v) => !v)}
      >
        <div className="fc-face fc-front">
          <div className="fc-label">Question</div>
          <div className="md fc-text" dangerouslySetInnerHTML={{ __html: md(card.front) }} />
          <div className="fc-hint">Click to flip</div>
        </div>
        <div className="fc-face fc-back">
          <div className="fc-label">Answer</div>
          <div className="md fc-text" dangerouslySetInnerHTML={{ __html: md(card.back) }} />
          <SourceLink n={card.source} sources={sources} onOpen={onOpen} />
        </div>
      </div>
      <div className="fc-nav">
        <button className="btn is-ghost" onClick={() => go(-1)}>
          <ArrowLeft size={15} />
        </button>
        <button
          className={cx('btn', known.has(i) ? 'is-secondary' : 'is-ghost')}
          onClick={() => {
            setKnown((k) => {
              const n = new Set(k);
              if (n.has(i)) n.delete(i);
              else n.add(i);
              return n;
            });
            go(1);
          }}
        >
          <Check size={15} /> I know this
        </button>
        <button className="btn is-ghost" onClick={() => go(1)}>
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

export function Quiz({ questions, sources, onOpen }: { questions: QuizQ[]; sources: SourceRef[]; onOpen(s: SourceRef): void }) {
  const [answers, setAnswers] = useState<(number | null)[]>(() => questions.map(() => null));
  const score = answers.filter((a, i) => a === questions[i].answer).length;
  const done = answers.every((a) => a !== null);
  const letters = useMemo(() => ['A', 'B', 'C', 'D', 'E'], []);
  return (
    <div className="quiz">
      {questions.map((q, qi) => {
        const picked = answers[qi];
        return (
          <div key={qi} className="quiz-q">
            <div className="quiz-q-head">
              <span className="quiz-n">{qi + 1}</span>
              <div className="md quiz-text" dangerouslySetInnerHTML={{ __html: md(q.q) }} />
            </div>
            <div className="quiz-choices">
              {q.choices.map((c, ci) => {
                const state = picked === null ? '' : ci === q.answer ? 'is-right' : ci === picked ? 'is-wrong' : 'is-dim';
                return (
                  <button
                    key={ci}
                    className={cx('quiz-choice', state)}
                    disabled={picked !== null}
                    onClick={() => setAnswers((a) => a.map((v, i) => (i === qi ? ci : v)))}
                  >
                    <span className="quiz-letter">
                      {picked !== null && ci === q.answer ? <Check size={12} /> : picked === ci ? <X size={12} /> : letters[ci]}
                    </span>
                    <span className="md" dangerouslySetInnerHTML={{ __html: md(c) }} />
                  </button>
                );
              })}
            </div>
            {picked !== null && (
              <div className={cx('quiz-explain', picked === q.answer ? 'is-right' : 'is-wrong')}>
                <b>{picked === q.answer ? 'Correct.' : 'Not quite.'}</b> <span className="md" dangerouslySetInnerHTML={{ __html: md(q.explain ?? '') }} />
                <SourceLink n={q.source} sources={sources} onOpen={onOpen} />
              </div>
            )}
          </div>
        );
      })}
      {done && (
        <div className="quiz-score">
          <div className="quiz-score-n">
            {score}/{questions.length}
          </div>
          <div>
            {score === questions.length
              ? 'Perfect — you know this material.'
              : score >= questions.length * 0.6
                ? 'Nice work. Review the ones you missed.'
                : 'Worth another pass through these notes.'}
          </div>
          <button className="btn is-ghost" onClick={() => setAnswers(questions.map(() => null))}>
            <RotateCcw size={14} /> Retake
          </button>
        </div>
      )}
    </div>
  );
}
