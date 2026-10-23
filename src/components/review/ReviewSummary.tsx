import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { conceptsOf, useReview } from '../../state/review';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { renderMarkdown } from '../../lib/ai/markdown';
import { calibrationMessage, dayLabel } from '../../lib/review/session';
import { percent, statusOf } from '../../lib/review/mastery';
import { isReviewable } from '../../lib/review/tree';
import { GroupMark } from './parts';
import { cx, plural } from '../../lib/util';

const CONF_LABEL = { sure: 'Sure', unsure: 'Unsure', guess: 'Guessing' } as const;

/**
 * The end of a session: an honest heading, one plain line of numbers, Done (and practising what's still
 * shaky), then progress by class and the ideas still being learned beside what the notes say.
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
  // The same "still learning" the counts use: answered, not mastered. What needs study and the mix-ups come first.
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

  const mins = Math.max(1, Math.round(summary.durationMs / 60_000));
  const done = () => useReview.getState().closeSummary();
  const open = (id: string) => {
    const m = meta(id);
    if (m && notes[m.noteId]) useUI.getState().openNote(m.noteId);
  };
  const line = [
    !summary.stopped && plural(summary.items, 'question'),
    `${summary.correct} right`,
    `${mins} min`,
    summary.masteredToday.length > 0 && `${plural(summary.masteredToday.length, 'idea')} mastered`,
  ]
    .filter(Boolean)
    .join(' · ');

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
      <div className="md rv-idea-def" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.says) }} />
      <button className="icon-btn is-tiny rv-idea-open" onClick={() => open(x.id)} title="Open the note" aria-label={`Open the note for ${name(x.id)}`}>
        <ExternalLink size={14} />
      </button>
    </div>
  );

  return (
    <div className="screen review-view rv-summary">
      <div className="screen-scroll">
        <div className="rv-summary-column">
          <header className="rv-summary-head">
            <div className="rv-summary-label" title={summary.label}>
              {summary.label}
            </div>
            <h1>{summary.stopped ? `Stopped after ${plural(summary.items, 'question')}` : 'Session complete'}</h1>
            <div className="rv-summary-sub">{line}</div>
            <div className="rv-summary-actions">
              <button className="btn is-primary" onClick={done}>
                Done
              </button>
              {missedNotes.length > 0 && (
                <button className="btn is-secondary" onClick={() => useReview.getState().start(missedNotes)}>
                  Practice the {plural(learning.length, 'tough idea')}
                </button>
              )}
            </div>
          </header>

          <section className="rv-section">
            <h2 className="rv-section-title">By class</h2>
            <div className="rv-classes">
              {summary.byClass.map((c) => (
                <div key={c.key} className="rv-class-row">
                  <span className="rv-mark">
                    <GroupMark color={c.color} />
                  </span>
                  <span className="rv-class-name" title={c.name}>
                    {c.name}
                  </span>
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

          {learning.length > 0 && (
            <section className="rv-section">
              <h2 className="rv-section-title">Still learning · {learning.length}</h2>
              <div className="rv-ideas">{learning.map(ideaRow)}</div>
            </section>
          )}

          {summary.calibration.some((c) => c.n) && (
            <section className="rv-section rv-calib">
              <h2 className="rv-section-title">How sure vs. how right</h2>
              <div className="rv-calib-nums">
                {summary.calibration
                  .filter((c) => c.n)
                  .map((c) => `${CONF_LABEL[c.conf]}: ${c.correct} of ${c.n} right`)
                  .join(' · ')}
              </div>
              {calib && <div className="rv-calib-msg">{calib}</div>}
            </section>
          )}

          {summary.masteredToday.length > 0 && (
            <section className="rv-section">
              <div className="rv-section-head">
                <h2 className="rv-section-title">Mastered today · {summary.masteredToday.length}</h2>
                <button className="btn is-ghost is-small" aria-expanded={showMastered} onClick={() => setShowMastered(!showMastered)}>
                  {showMastered ? 'Hide' : 'Show'}
                  <ChevronDown size={14} className={cx('rv-chev-down', showMastered && 'is-open')} />
                </button>
              </div>
              {showMastered && <div className="rv-ideas">{summary.masteredToday.map((id) => ideaRow({ id, says: fact(id) }))}</div>}
            </section>
          )}

          {(summary.thin.length > 0 || summary.notReviewable.length > 0) && (
            <div className="rv-summary-notes">
              {summary.thin.length > 0 && (
                <div>
                  Thin in your notes: {summary.thin.slice(0, 6).map(name).join(', ')}. Add a sentence or two and Review can ask about{' '}
                  {summary.thin.length === 1 ? 'it' : 'them'} in more depth.
                </div>
              )}
              {summary.notReviewable.length > 0 && <div>Handwriting not read yet: {summary.notReviewable.join(', ')}.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
