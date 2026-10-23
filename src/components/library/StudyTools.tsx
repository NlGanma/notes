import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, MessageSquareText, X } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { parseStudyJSON, type Card, type QuizQ } from '../../lib/ai/study';
import { renderMarkdown } from '../../lib/ai/markdown';
import type { SourceRef } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';
import { sourceTitle } from '../ai/Citations';

export { parseStudyJSON };
export type { Card, QuizQ };

const md = (s: string) => renderMarkdown(s);

/** Keys for a study artifact, unless the student is typing somewhere. */
function useKeys(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"], .modal-backdrop')) return;
      handler(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function SourceLink({ n, sources, onOpen }: { n?: number; sources: SourceRef[]; onOpen(s: SourceRef): void }) {
  const src = sources.find((s) => s.n === n);
  if (!src) return null;
  return (
    <button
      className="study-source"
      title="Open in note"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(src);
      }}
    >
      <span className="cite-n">{src.n}</span>
      <span className="study-source-text">
        {sourceTitle(src)}
        {src.section ? ` › ${src.section.split(' › ').pop()}` : ''}
      </span>
    </button>
  );
}

/** Saves the deck as a note (AI-written, so it's never cited back as class material). */
export function saveFlashcards(cards: Card[], title = 'Flashcards', folder = '') {
  const content: JSONContent[] = [];
  for (const c of cards) {
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: c.front.replace(/\$/g, '') }] });
    content.push({ type: 'paragraph', content: [{ type: 'text', text: c.back }] });
  }
  const doc = useVault.getState().createNote({ folder, title, tags: ['flashcards'], content: { type: 'doc', content }, generated: true });
  useUI.getState().openNote(doc.meta.id, { newTab: true });
}

type Mark = 'got' | 'missed';

/**
 * NotebookLM's flashcards: one big calm card, "See answer" to flip, then mark
 * it "Got it" or "Missed it" (which moves on). Space flips, ← → move, G / M mark.
 */
export function Flashcards({
  cards: initial,
  sources,
  order,
  onOpen,
  onExplain,
}: {
  cards: Card[];
  sources: SourceRef[];
  /** Bumped by the header's Shuffle. */
  order?: number;
  onOpen(s: SourceRef): void;
  onExplain?(front: string): void;
}) {
  const [cards, setCards] = useState(initial);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [marks, setMarks] = useState<(Mark | undefined)[]>(() => initial.map(() => undefined));
  const [done, setDone] = useState(false);
  const restart = (next: Card[]) => {
    setCards(next);
    setI(0);
    setFlipped(false);
    setMarks(next.map(() => undefined));
    setDone(false);
  };
  // A new deck (or a shuffle) starts fresh.
  const [forCards, setForCards] = useState({ initial, order });
  if (forCards.initial !== initial || forCards.order !== order) {
    setForCards({ initial, order });
    restart(forCards.initial !== initial ? initial : [...cards].sort(() => Math.random() - 0.5));
  }
  const card = cards[i];
  const go = (to: number) => {
    if (to < 0 || to >= cards.length) return;
    setFlipped(false);
    setI(to);
  };
  const mark = (m: Mark) => {
    const next = marks.map((v, k) => (k === i ? m : v));
    setMarks(next);
    // Marking moves on to the next unmarked card; when there's none left, the round is over.
    window.setTimeout(() => {
      const after = [...next.keys()].find((k) => k > i && !next[k]) ?? [...next.keys()].find((k) => !next[k]);
      if (after === undefined) setDone(true);
      else go(after);
    }, 250);
  };
  useKeys(
    (e) => {
      if (done) return;
      if (e.key === ' ') {
        e.preventDefault();
        setFlipped((v) => !v);
      } else if (e.key === 'ArrowLeft') go(i - 1);
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (flipped && (e.key === 'g' || e.key === 'G')) mark('got');
      else if (flipped && (e.key === 'm' || e.key === 'M')) mark('missed');
    },
    [i, flipped, done, cards, marks],
  );

  if (done) {
    const got = marks.filter((m) => m === 'got').length;
    const missed = cards.filter((_, k) => marks[k] === 'missed');
    return (
      <div className="flashcards fc-end">
        <div className="fc-end-score">
          You got {got} of {cards.length}
        </div>
        <div className="study-bar">
          <span style={{ width: `${(got / cards.length) * 100}%` }} />
        </div>
        <div className="fc-end-actions">
          {missed.length > 0 && (
            <button className="btn is-primary" onClick={() => restart(missed)}>
              Practise missed ({missed.length})
            </button>
          )}
          <button className="btn is-secondary" onClick={() => restart(initial)}>
            All cards
          </button>
          <button className="btn is-secondary" onClick={() => restart(cards)}>
            Same cards
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flashcards">
      <div className="fc-hint">Press Space to flip, ← → to move</div>
      <div
        className={cx('fc-card', flipped && 'is-flipped')}
        onClick={() => setFlipped((v) => !v)}
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show the question' : 'Show the answer'}
        onKeyDown={(e) => e.key === 'Enter' && setFlipped((v) => !v)}
      >
        <div className="fc-face fc-front" aria-hidden={flipped}>
          <div className="md fc-text" dangerouslySetInnerHTML={{ __html: md(card.front) }} />
          <span className="fc-see">See answer</span>
        </div>
        <div className="fc-face fc-back" aria-hidden={!flipped}>
          <div className="fc-back-body">
            <div className="md fc-text" dangerouslySetInnerHTML={{ __html: md(card.back) }} />
            <SourceLink n={card.source} sources={sources} onOpen={onOpen} />
          </div>
          <div className="fc-bar" onClick={(e) => e.stopPropagation()}>
            {onExplain && (
              <button className="fc-pill" onClick={() => onExplain(card.front)}>
                <MessageSquareText size={18} /> Explain
              </button>
            )}
            <span className="grow" />
            <button className={cx('fc-pill is-missed', marks[i] === 'missed' && 'is-on')} onClick={() => mark('missed')} title="Missed it (M)">
              <X size={18} /> Missed it
            </button>
            <button className={cx('fc-pill is-got', marks[i] === 'got' && 'is-on')} onClick={() => mark('got')} title="Got it (G)">
              <Check size={18} /> Got it
            </button>
          </div>
        </div>
        {marks[i] && !flipped && <span className={cx('fc-mark', `is-${marks[i]}`)}>{marks[i] === 'got' ? <Check size={14} /> : <X size={14} />}</span>}
      </div>
      <div className="fc-nav">
        <button className="study-nav-btn" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous card">
          <ArrowLeft size={20} />
        </button>
        <span className="fc-count">
          {i + 1} / {cards.length} cards
        </span>
        <button className="study-nav-btn" onClick={() => go(i + 1)} disabled={i === cards.length - 1} aria-label="Next card">
          <ArrowRight size={20} />
        </button>
      </div>
    </div>
  );
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/**
 * NotebookLM's quiz: one question at a time, big soft option cards (A–D), a
 * short verdict with the sentence from the notes, and a sticky footer.
 * A–D answer, ← → move, Enter goes on.
 */
export function Quiz({
  questions,
  sources,
  onOpen,
  onExplain,
}: {
  questions: QuizQ[];
  sources: SourceRef[];
  onOpen(s: SourceRef): void;
  onExplain?(q: QuizQ, picked: number | null): void;
}) {
  const [answers, setAnswers] = useState<(number | null)[]>(() => questions.map(() => null));
  const [i, setI] = useState(0);
  const [done, setDone] = useState(false);
  // A new set of questions starts fresh.
  const [forQs, setForQs] = useState(questions);
  if (forQs !== questions) {
    setForQs(questions);
    setAnswers(questions.map(() => null));
    setI(0);
    setDone(false);
  }
  const score = useMemo(() => answers.filter((a, k) => a === questions[k]?.answer).length, [answers, questions]);
  const q = questions[i];
  const picked = answers[i];
  const last = i === questions.length - 1;
  const answer = (ci: number) => {
    if (picked !== null || ci >= q.choices.length) return;
    setAnswers((a) => a.map((v, k) => (k === i ? ci : v)));
  };
  const next = () => (last ? setDone(true) : setI(i + 1));
  useKeys(
    (e) => {
      if (done) return;
      const k = LETTERS.indexOf(e.key.toUpperCase());
      if (k >= 0 && e.key.length === 1) answer(k);
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      }
    },
    [i, picked, done, last],
  );

  if (done) {
    return (
      <div className="quiz quiz-end">
        <div className="fc-end-score">
          You scored {score} / {questions.length}
        </div>
        <div className="study-bar">
          <span style={{ width: `${(score / questions.length) * 100}%` }} />
        </div>
        <div className="quiz-end-note">
          {score === questions.length
            ? 'Perfect: you know this material.'
            : score >= questions.length * 0.6
              ? 'Nice work. Go over the ones you missed.'
              : 'Worth another pass through these notes.'}
        </div>
        <div className="fc-end-actions">
          <button
            className="btn is-secondary"
            onClick={() => {
              setI(0);
              setDone(false);
            }}
          >
            Review answers
          </button>
          <button
            className="btn is-primary"
            onClick={() => {
              setAnswers(questions.map(() => null));
              setI(0);
              setDone(false);
            }}
          >
            Retake quiz
          </button>
        </div>
      </div>
    );
  }

  const feedback = (ci: number) => {
    if (picked === null) return null;
    if (ci === q.answer)
      return (
        <div className="quiz-explain is-right">
          <div className="quiz-verdict">Right answer</div>
          {q.explain && <span className="md" dangerouslySetInnerHTML={{ __html: md(q.explain) }} />}
          <SourceLink n={q.source} sources={sources} onOpen={onOpen} />
        </div>
      );
    if (ci === picked)
      return (
        <div className="quiz-explain is-wrong">
          <div className="quiz-verdict">Not quite</div>
        </div>
      );
    return null;
  };

  return (
    <div className="quiz">
      <div className="quiz-q">
        <div className="quiz-count">
          {i + 1} / {questions.length}
        </div>
        <div className="md quiz-text" dangerouslySetInnerHTML={{ __html: md(q.q) }} />
        <div className="quiz-choices">
          {q.choices.map((c, ci) => {
            const state = picked === null ? '' : ci === q.answer ? 'is-right' : ci === picked ? 'is-wrong' : 'is-dim';
            return (
              <div key={ci} className="quiz-option">
                <button className={cx('quiz-choice', state)} disabled={picked !== null} onClick={() => answer(ci)}>
                  <span className="quiz-letter">
                    {picked !== null && ci === q.answer ? <Check size={14} /> : picked === ci ? <X size={14} /> : `${LETTERS[ci]}.`}
                  </span>
                  <span className="md" dangerouslySetInnerHTML={{ __html: md(c) }} />
                </button>
                {feedback(ci)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="quiz-foot">
        {picked !== null && onExplain && (
          <button className="btn is-secondary quiz-explain-btn" onClick={() => onExplain(q, picked)}>
            <MessageSquareText size={18} /> Explain
          </button>
        )}
        <span className="grow" />
        <button className="btn quiz-prev" onClick={() => setI(i - 1)} disabled={i === 0}>
          Previous
        </button>
        <button className="btn is-primary" onClick={next}>
          {last ? 'See results' : 'Next'}
        </button>
      </div>
    </div>
  );
}
