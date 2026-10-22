import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Layers, RotateCcw, Target } from 'lucide-react';
import { conceptsOf, useReview } from '../../state/review';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAssistant } from '../../state/assistant';
import { renderMarkdown } from '../../lib/ai/markdown';
import { calibrationMessage, dayLabel } from '../../lib/review/session';
import { percent, statusOf } from '../../lib/review/mastery';
import { isReviewable } from '../../lib/review/tree';
import { openLibrary } from '../../lib/commands';
import { ClassLetter, Donut, StudyBar } from './parts';
import { cx, plural } from '../../lib/util';

/** Quizlet's results headline, by score band. */
function headline(pct: number, stopped?: boolean) {
  if (stopped) return 'Nice job!';
  if (pct >= 100) return 'Wow, you know your stuff!';
  if (pct >= 80) return 'You’re crushing it! Don’t stop now.';
  if (pct >= 50) return 'You’re getting there! Keep going so you really get it.';
  return 'You’re doing great! Keep it up to build confidence.';
}

const CONF_LABEL = { sure: 'Sure', unsure: 'Unsure', guess: 'Guessing' } as const;

/**
 * The end of a session, as Quizlet's results: a plain-words headline, "How you're doing" (score, then a donut
 * with Mastered / Still learning / Not studied) beside "Next steps", progress by class, then the ideas still
 * being learned as term | definition rows. All from the learner model.
 */
export function ReviewSummary() {
  const summary = useReview((s) => s.summary)!;
  const pool = useReview((s) => s.pool);
  const file = useReview((s) => s.file);
  const notes = useVault((s) => s.notes);
  const [showMastered, setShowMastered] = useState(false);
  const meta = (id: string) => pool.find((p) => p.id === id);
  const name = (id: string) => meta(id)?.name ?? 'An idea';
  const calib = calibrationMessage(summary.calibration);

  // Ideas missed this session (and how they were mixed up), with what the notes say about each.
  const fact = (id: string) => {
    const m = meta(id);
    const n = m && notes[m.noteId];
    return n ? (conceptsOf(n).find((c) => c.id === id)?.facts[0]?.text ?? '') : '';
  };
  // The same "still learning" the counts use: answered, not mastered — what needs study and the mix-ups first.
  const learning = useMemo(() => {
    const now = Date.now();
    const still = pool.filter((p) => {
      const st = statusOf(file.states[p.id], p.cap, summary.needsStudy.includes(p.id), p.needs);
      return st === 'learning' || st === 'needs-study';
    });
    const rank = (id: string) => (summary.needsStudy.includes(id) ? 0 : summary.misconceptions.some((m) => m.conceptId === id) ? 1 : 2);
    return still
      .map((p) => p.id)
      .sort((a, b) => rank(a) - rank(b) || percent(file.states[a], now) - percent(file.states[b], now))
      .map((id) => {
        const mix = summary.misconceptions.find((m) => m.conceptId === id);
        return { id, wrote: mix?.wrote, says: mix?.notesSay ?? fact(id) };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, pool, notes]);
  const missedNotes = useMemo(
    () => [...new Set(learning.map((x) => meta(x.id)?.noteId))].filter((x): x is string => !!x && !!notes[x] && isReviewable(notes[x])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [learning, notes],
  );
  const sessionNotes = useMemo(() => [...new Set(pool.map((p) => p.noteId))].filter((id) => notes[id]), [pool, notes]);

  const mins = Math.max(1, Math.round(summary.durationMs / 60_000));
  const pct = summary.items ? Math.round((summary.correct / summary.items) * 100) : 0;
  const totals = summary.byClass.reduce((a, c) => ({ mastered: a.mastered + c.mastered, learning: a.learning + c.learning, fresh: a.fresh + c.newCount, total: a.total + c.total }), {
    mastered: 0,
    learning: 0,
    fresh: 0,
    total: 0,
  });
  const masteredPct = totals.total ? Math.round((totals.mastered / totals.total) * 100) : 0;

  const done = () => useReview.getState().closeSummary();
  const flashcards = () => {
    const scope = { kind: 'notes' as const, ids: sessionNotes };
    openLibrary(scope);
    void useAssistant.getState().askLibrary({ prompt: '', scope, scopeLabel: summary.label, tool: 'flashcards' });
  };
  const open = (id: string) => {
    const m = meta(id);
    if (m && notes[m.noteId]) useUI.getState().openNote(m.noteId, { newTab: true });
  };

  const steps = [
    missedNotes.length > 0 && {
      key: 'tough',
      icon: <RotateCcw size={20} />,
      title: 'Review the tough ideas',
      desc: `Practise the ${plural(learning.length, 'idea')} you’re still learning.`,
      run: () => useReview.getState().start(missedNotes),
    },
    sessionNotes.length > 0 && {
      key: 'cards',
      icon: <Layers size={20} />,
      title: 'Make flashcards',
      desc: 'Study each idea as a flashcard to improve recall.',
      run: flashcards,
    },
    {
      key: 'new',
      icon: <Target size={20} />,
      title: 'Start a new review',
      desc: 'Pick different notes or a different length.',
      run: done,
    },
  ].filter(Boolean) as { key: string; icon: JSX.Element; title: string; desc: string; run(): void }[];

  const ideaRow = (x: { id: string; wrote?: string; says: string }) => (
    <div key={x.id} className="rv-idea">
      <div className="rv-idea-term">
        <div className="rv-idea-name">{name(x.id).replace(/\*\*/g, '')}</div>
        {x.wrote && (
          <div className="rv-idea-said">
            <span>You said</span> {x.wrote}
          </div>
        )}
      </div>
      <span className="rv-idea-rule" />
      <div className="md rv-idea-def" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.says) }} />
      <button className="icon-btn rv-idea-open" onClick={() => open(x.id)} title="Open the note" aria-label={`Open the note for ${name(x.id)}`}>
        <ExternalLink size={18} />
      </button>
    </div>
  );

  return (
    <div className="page review-view rv-summary">
      <StudyBar title={summary.label}>
        <div className="rv-summary-actions">
          <button className="btn is-primary" onClick={done}>
            Done
          </button>
        </div>
      </StudyBar>

      <div className="page-scroll">
        <div className="rv-summary-column">
          <header className="rv-summary-head">
            <h1>{headline(pct, summary.stopped)}</h1>
            <div className="rv-summary-sub">
              {summary.stopped ? `Stopped after ${plural(summary.items, 'question')}` : `Session complete · ${plural(summary.items, 'question')}`} · {mins} min
            </div>
          </header>

          <div className="rv-summary-grid">
            <section className="rv-scard">
              <h2 className="rv-scard-title">How you’re doing</h2>
              <div className="rv-score">
                <div>
                  <span>Score</span>
                  <b>{pct}%</b>
                </div>
                <div>
                  <span>Results</span>
                  <b>
                    {summary.correct}/{summary.items}
                  </b>
                </div>
                <div>
                  <span>Total time</span>
                  <b>{mins}m</b>
                </div>
              </div>
              <div className="rv-howdoing">
                <Donut mastered={totals.mastered} learning={totals.learning} total={totals.total}>
                  <b>{masteredPct}%</b>
                  <span>Mastered</span>
                </Donut>
                <div className="rv-legend">
                  <span className="rv-legend-pill is-mastered">
                    <b>{totals.mastered}</b> Mastered
                  </span>
                  <span className="rv-legend-pill is-learning">
                    <b>{totals.learning}</b> Still learning
                  </span>
                  <span className="rv-legend-pill is-fresh">
                    <b>{totals.fresh}</b> Not studied
                  </span>
                </div>
              </div>
              {summary.calibration.some((c) => c.n) && (
                <div className="rv-calib">
                  <div className="rv-calib-head">How sure vs. how right</div>
                  <div className="rv-calib-nums">
                    {summary.calibration
                      .filter((c) => c.n)
                      .map((c) => `${CONF_LABEL[c.conf]} ${c.correct}/${c.n}`)
                      .join(' · ')}
                  </div>
                  {calib && <div className="rv-calib-msg">{calib}</div>}
                </div>
              )}
            </section>

            <section className="rv-scard is-steps">
              <h2 className="rv-scard-title">Next steps</h2>
              <div className="rv-steps">
                {steps.map((s) => (
                  <button key={s.key} className="rv-step" onClick={s.run}>
                    <span className="rv-step-icon">{s.icon}</span>
                    <span className="rv-step-text">
                      <span className="rv-step-title">{s.title}</span>
                      <span className="rv-step-desc">{s.desc}</span>
                    </span>
                    <ChevronRight size={20} className="rv-step-chev" />
                  </button>
                ))}
              </div>
            </section>
          </div>

          <section className="rv-section">
            <h2 className="rv-section-title">By class</h2>
            <div className="rv-classes">
              {summary.byClass.map((c) => (
                <div key={c.key} className="rv-class-row">
                  <ClassLetter name={c.name} color={c.color} />
                  <span className="rv-class-name">{c.name}</span>
                  <span className="rv-bar is-wide">
                    <span style={{ width: `${c.percent}%` }} />
                  </span>
                  <span className="rv-pct">{c.percent}%</span>
                  <span className="rv-class-meta">
                    {c.mastered}/{c.total} mastered · next review {dayLabel(c.nextDue)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="rv-section">
            <h2 className="rv-section-title">Still learning ({learning.length})</h2>
            {learning.length ? <div className="rv-ideas">{learning.map(ideaRow)}</div> : <div className="rv-none">Nothing to fix — every idea landed.</div>}
          </section>

          {summary.masteredToday.length > 0 && (
            <section className="rv-section">
              <div className="rv-section-head">
                <h2 className="rv-section-title">Mastered today ({summary.masteredToday.length})</h2>
                <button className="btn is-ghost" aria-expanded={showMastered} onClick={() => setShowMastered(!showMastered)}>
                  {showMastered ? 'Hide' : `Show ${summary.masteredToday.length}`}
                  <ChevronDown size={18} className={cx('rv-chev-down', showMastered && 'is-open')} />
                </button>
              </div>
              {showMastered && <div className="rv-ideas">{summary.masteredToday.map((id) => ideaRow({ id, says: fact(id) }))}</div>}
            </section>
          )}

          {(summary.thin.length > 0 || summary.notReviewable.length > 0) && (
            <div className="rv-summary-notes">
              {summary.thin.length > 0 && (
                <div>
                  Thin in your notes: {summary.thin.slice(0, 6).map(name).join(', ')} — add a sentence or two and Review can ask about {summary.thin.length === 1 ? 'it' : 'them'} in more depth.
                </div>
              )}
              {summary.notReviewable.length > 0 && <div>Not reviewable yet (handwriting not transcribed): {summary.notReviewable.join(', ')}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
