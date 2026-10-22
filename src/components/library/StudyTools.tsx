import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FilePlus2, RotateCcw, Shuffle, X } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { parseStudyJSON, type Card, type QuizQ } from '../../lib/ai/study';
import { renderMarkdown } from '../../lib/ai/markdown';
import type { SourceRef } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';

export { parseStudyJSON };
export type { Card, QuizQ };

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
  // A new set of cards starts fresh.
  const [forCards, setForCards] = useState(initial);
  if (forCards !== initial) {
    setForCards(initial);
    setCards(initial);
    setI(0);
    setFlipped(false);
    setKnown(new Set());
  }
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
    const doc = useVault.getState().createNote({ title: 'Flashcards', tags: ['flashcards'], content: { type: 'doc', content }, generated: true });
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
  // A new set of questions starts fresh.
  const [forQs, setForQs] = useState(questions);
  if (forQs !== questions) {
    setForQs(questions);
    setAnswers(questions.map(() => null));
  }
  const score = answers.filter((a, i) => a === questions[i]?.answer).length;
  const done = answers.length === questions.length && answers.every((a) => a !== null);
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
