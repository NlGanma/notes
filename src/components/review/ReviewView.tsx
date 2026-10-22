import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { dueNotes, useReview } from '../../state/review';
import { buildReviewTree, isReviewable, selectionLabel } from '../../lib/review/tree';
import { notReviewable } from '../../lib/review/concepts';
import { dayLabel } from '../../lib/review/session';
import { ReviewPicker } from './ReviewPicker';
import { ReviewSession } from './ReviewSession';
import { ReviewSummary } from './ReviewSummary';
import { countIdeas, Ring, Switch } from './parts';
import { cx, plural } from '../../lib/util';

const LENGTHS: { n: number; label: string }[] = [
  { n: 10, label: 'Quick' },
  { n: 15, label: 'Standard' },
  { n: 25, label: 'Long' },
];

/** Review: pick any notes (mix classes if you like), then practise until you know them. */
export function ReviewView({ preset }: { preset?: string[] }) {
  const loaded = useReview((s) => s.loaded);
  const session = useReview((s) => s.session);
  const summary = useReview((s) => s.summary);

  useEffect(() => {
    void useReview.getState().load();
  }, []);
  // A request to review some notes (none, when nothing is due): a session in progress ends — its answers are
  // kept and its summary shown — and the picker shows those notes once it's closed. Once per request (a
  // second run of the effect would close that summary).
  const handled = useRef<string[]>();
  useEffect(() => {
    if (!preset || handled.current === preset) return;
    handled.current = preset;
    useReview.getState().request(preset);
  }, [preset]);

  if (session) return <ReviewSession />;
  if (summary) return <ReviewSummary />;
  return <ReviewSetup loaded={loaded} />;
}

/**
 * The setup page: Anki's deck list on the left (pick notes, with New / Due / Mastery per row), and on the
 * right Quizlet's "Set up your test" card — the selection's progress, the options as described rows, Start.
 */
function ReviewSetup({ loaded }: { loaded: boolean }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const selection = useReview((s) => s.selection);
  const opts = useReview((s) => s.opts);
  const reading = useReview((s) => s.reading);
  const file = useReview((s) => s.file);
  const online = useAI((s) => s.status === 'online');
  const tree = useMemo(() => buildReviewTree(notes, folders, folderMeta), [notes, folders, folderMeta]);
  // Picked notes that can still be reviewed (not trashed since).
  const selected = useMemo(() => new Set(selection.filter((id) => notes[id] && isReviewable(notes[id]))), [selection, notes]);

  // What the selection holds: its ideas in Quizlet's three buckets, what's due, and what can't be reviewed.
  const stats = useMemo(() => {
    const picked = [...selected].map((id) => notes[id]).filter(Boolean);
    const counts = countIdeas(picked, file);
    const blocked: { id: string; label: string }[] = [];
    const groups = new Set<string>();
    for (const n of picked) {
      for (const s of notReviewable(n)) blocked.push({ id: n.meta.id, label: s === n.meta.title ? s : `${n.meta.title} › ${s}` });
      groups.add(tree.find((g) => g.chapters.some((ch) => ch.notes.some((x) => x.meta.id === n.meta.id)))?.key ?? '');
    }
    return { ...counts, blocked, groups: groups.size };
  }, [selected, notes, file, tree]);
  // A session asks what's due or new; with neither there's nothing to start.
  const askable = stats.due + stats.fresh > 0;
  const canStart = selected.size > 0 && stats.total > 0 && askable && loaded;

  // "What's due": every note with an idea due now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dueIds = useMemo(() => (loaded ? dueNotes().ids : []), [notes, file, loaded]);

  const set = (ids: Set<string>) => useReview.getState().setSelection([...ids]);
  // Stacked under the list (a narrow pane), the card's Start can be out of view: a bottom bar stands in for it.
  const startRef = useRef<HTMLButtonElement>(null);
  const [startInView, setStartInView] = useState(true);
  useEffect(() => {
    const el = startRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setStartInView(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // A progress row narrows the selection to the notes with ideas in that bucket (Quizlet: "Select Not studied
  // or Still learning to start studying that group").
  const narrow = (bucket: 'fresh' | 'learning') => {
    const keep = [...selected].filter((id) => countIdeas([notes[id]], file)[bucket] > 0);
    if (keep.length) set(new Set(keep));
  };

  const helper = !selected.size
    ? 'Pick notes to start.'
    : !stats.total
      ? 'Nothing in these notes can be asked about yet.'
      : !askable
        ? `You’ve finished these notes for now. Next review ${dayLabel(stats.next)}.`
        : null;

  return (
    <div className="screen review-view rv-setup-page">
      <div className="screen-head">
        <h1 className="screen-title">Review</h1>
        <span className="grow" />
        {dueIds.length > 0 && (
          <button className="btn is-secondary" onClick={() => set(new Set(dueIds))}>
            What’s due · {plural(dueIds.length, 'note')}
          </button>
        )}
      </div>
      <div className="screen-scroll">
        <div className="rv-setup-column">
          <div className="rv-intro">Quiz yourself on any notes. Questions and answers come only from them.</div>
          <div className="rv-setup">
            <ReviewPicker selected={selected} onChange={set} />

            <aside className="rv-panel" aria-label="Set up your review">
              <div className="rv-panel-label">{selected.size ? selectionLabel(tree, selected) : 'Nothing picked yet'}</div>
              <h2 className="rv-panel-title">Set up your review</h2>

              <div className="rv-buckets">
                <button className="rv-bucket" disabled={!stats.fresh || selected.size < 2} onClick={() => narrow('fresh')} title="Review only the notes with ideas not studied yet">
                  <Ring value={stats.fresh} total={stats.total} tone="fresh" />
                  <span className="rv-bucket-label">Not studied</span>
                  <span className="rv-bucket-n">{selected.size ? stats.fresh : '–'}</span>
                </button>
                <button className="rv-bucket" disabled={!stats.learning || selected.size < 2} onClick={() => narrow('learning')} title="Review only the notes with ideas you’re still learning">
                  <Ring value={stats.learning} total={stats.total} tone="learning" />
                  <span className="rv-bucket-label">Still learning</span>
                  <span className="rv-bucket-n">{selected.size ? stats.learning : '–'}</span>
                </button>
                <div className="rv-bucket">
                  <Ring value={stats.mastered} total={stats.total} tone="mastered" />
                  <span className="rv-bucket-label">Mastered</span>
                  <span className="rv-bucket-n">{selected.size ? stats.mastered : '–'}</span>
                </div>
              </div>
              {selected.size > 0 && (
                <div className="rv-panel-stats">
                  {plural(stats.total, 'idea')}
                  {stats.due > 0 ? ` · ${stats.due} due now` : !askable && stats.total ? ` · next review ${dayLabel(stats.next)}` : ''}
                  {reading && (
                    <span className="rv-reading">
                      {' '}
                      · <span className="rv-spinner" /> finding more
                    </span>
                  )}
                </div>
              )}

              <div className="rv-options">
                <div className="rv-option is-stacked">
                  <span className="rv-option-text">
                    <span className="rv-option-label">Length</span>
                    <span className="rv-option-desc">{opts.length} questions</span>
                  </span>
                  <div className="seg rv-length" role="radiogroup" aria-label="Length">
                    {LENGTHS.map((l) => (
                      <button key={l.n} role="radio" aria-checked={opts.length === l.n} className={cx(opts.length === l.n && 'is-active')} onClick={() => useReview.getState().setOpts({ length: l.n })}>
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className={cx('rv-option rv-check', stats.groups < 2 && 'is-off')}>
                  <span className="rv-option-text">
                    <span className="rv-option-label">Mix classes</span>
                    <span className="rv-option-desc">{stats.groups < 2 ? 'Pick notes from two or more classes' : 'Questions from different classes take turns'}</span>
                  </span>
                  <Switch checked={opts.mix && stats.groups >= 2} disabled={stats.groups < 2} onChange={(v) => useReview.getState().setOpts({ mix: v })} />
                </label>
                <label className="rv-option rv-check">
                  <span className="rv-option-text">
                    <span className="rv-option-label">Ask how sure I am</span>
                    <span className="rv-option-desc">Spot confident mix-ups</span>
                  </span>
                  <Switch checked={opts.askConfidence} onChange={(v) => useReview.getState().setOpts({ askConfidence: v })} />
                </label>
              </div>

              {stats.blocked.length > 0 && (
                <div className="rv-warn">
                  <AlertTriangle size={18} />
                  <span>
                    Handwriting in{' '}
                    {stats.blocked.map((b, i) => (
                      <Fragment key={i}>
                        {i === 0 ? '' : i === stats.blocked.length - 1 ? ' and ' : ', '}
                        <button className="rv-warn-link" onClick={() => useUI.getState().openNote(b.id, { newTab: true })} title="Open this note">
                          {b.label}
                        </button>
                      </Fragment>
                    ))}{' '}
                    isn’t transcribed yet, so it can’t be reviewed. Open the note and use “Read handwriting”.
                  </span>
                </div>
              )}

              {helper && <div className="rv-helper">{helper}</div>}
              <button ref={startRef} className="btn is-primary rv-start" disabled={!canStart} onClick={() => useReview.getState().start([...selected])}>
                Start review
              </button>
              {!online && <div className="rv-promise">Your local model is offline — questions are built straight from your notes.</div>}
            </aside>
          </div>
          {!startInView && (
            <div className="rv-startbar">
              <span className="rv-startbar-label">{selected.size ? selectionLabel(tree, selected) : 'Nothing picked yet'}</span>
              <button className="btn is-primary" disabled={!canStart} onClick={() => useReview.getState().start([...selected])}>
                Start review
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
