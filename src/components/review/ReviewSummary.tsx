import { useMemo } from 'react';
import { CheckCircle2, RotateCcw, TrendingUp } from 'lucide-react';
import { useReview } from '../../state/review';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { renderMarkdown } from '../../lib/ai/markdown';
import { calibrationMessage } from '../../lib/review/session';
import { DAY } from '../../lib/review/mastery';

function when(t: number | null): string {
  if (!t) return '—';
  const days = Math.round((t - Date.now()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The end of a session: what was mastered, what to fix, when to come back. All from the learner model. */
export function ReviewSummary() {
  const summary = useReview((s) => s.summary)!;
  const pool = useReview((s) => s.pool);
  const notes = useVault((s) => s.notes);
  const name = (id: string) => pool.find((p) => p.id === id)?.name ?? 'An idea';
  const noteOf = (id: string) => pool.find((p) => p.id === id)?.noteId;
  const calib = calibrationMessage(summary.calibration);
  const missed = useMemo(
    () => [...new Set([...summary.needsStudy, ...summary.misconceptions.map((m) => m.conceptId)])].map(noteOf).filter((x): x is string => !!x && !!notes[x]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, notes],
  );
  const mins = Math.max(1, Math.round(summary.durationMs / 60_000));
  const pct = summary.items ? Math.round((summary.correct / summary.items) * 100) : 0;

  return (
    <div className="collection review-view rv-summary">
      <div className="rv-summary-head">
        <h1>Session complete</h1>
        <div className="collection-sub">
          {summary.label} · {summary.items} {summary.items === 1 ? 'question' : 'questions'} · {mins} min · {pct}% right
        </div>
      </div>

      <div className="rv-summary-stats">
        <span className="rv-stat is-good">
          <CheckCircle2 size={15} /> {summary.masteredToday.length} mastered today
        </span>
        <span className="rv-stat">
          <TrendingUp size={15} /> {summary.improved.length} improved
        </span>
        {summary.needsStudy.length > 0 && <span className="rv-stat is-warn">{summary.needsStudy.length} need study</span>}
      </div>

      <div className="rv-classes">
        {summary.byClass.map((c) => (
          <div key={c.key} className="rv-class-row" style={c.color ? { ['--class' as string]: c.color } : undefined}>
            <span className="rv-class-name">{c.name}</span>
            <span className="rv-bar is-wide">
              <span style={{ width: `${c.percent}%` }} />
            </span>
            <span className="rv-pct">{c.percent}%</span>
            <span className="rv-class-meta">
              {c.mastered}/{c.total} mastered · next review {when(c.nextDue)}
            </span>
          </div>
        ))}
      </div>

      {calib && (
        <div className="rv-summary-block">
          <div className="rv-block-head">How sure vs. how right</div>
          <div className="rv-calib">
            {summary.calibration
              .filter((c) => c.n)
              .map((c) => (
                <span key={c.conf}>
                  {c.conf === 'sure' ? 'Sure' : c.conf === 'unsure' ? 'Unsure' : 'Guessing'} {c.correct}/{c.n}
                </span>
              ))}
            <span className="rv-calib-msg">{calib}</span>
          </div>
        </div>
      )}

      {summary.misconceptions.length > 0 && (
        <div className="rv-summary-block">
          <div className="rv-block-head">Mix-ups to fix</div>
          {summary.misconceptions.map((m, i) => (
            <div key={i} className="rv-mixup">
              <span className="rv-mixup-name">{name(m.conceptId)}:</span> you wrote “{m.wrote}” — your notes say{' '}
              <span className="md is-inline" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.notesSay) }} />
            </div>
          ))}
        </div>
      )}

      {summary.needsStudy.length > 0 && (
        <div className="rv-summary-block">
          <div className="rv-block-head">Needs study</div>
          <div className="rv-chips">
            {summary.needsStudy.map((id) => (
              <button key={id} className="rv-chip" onClick={() => noteOf(id) && useUI.getState().openNote(noteOf(id)!, { newTab: true })}>
                {name(id)} ↗
              </button>
            ))}
          </div>
        </div>
      )}

      {(summary.thin.length > 0 || summary.notReviewable.length > 0) && (
        <div className="rv-summary-block is-muted">
          {summary.thin.length > 0 && (
            <div>
              Thin in your notes: {summary.thin.slice(0, 6).map(name).join(', ')} — add a sentence or two and Review can ask about {summary.thin.length === 1 ? 'it' : 'them'} in more depth.
            </div>
          )}
          {summary.notReviewable.length > 0 && <div>Not reviewable yet (handwriting not transcribed): {summary.notReviewable.join(', ')}</div>}
        </div>
      )}

      <div className="rv-summary-actions">
        {missed.length > 0 && (
          <button className="btn is-secondary" onClick={() => useReview.getState().start(missed)}>
            <RotateCcw size={14} /> Review what I missed
          </button>
        )}
        <span className="grow" />
        <button className="btn is-primary" onClick={() => useReview.getState().closeSummary()}>
          Done
        </button>
      </div>
    </div>
  );
}
