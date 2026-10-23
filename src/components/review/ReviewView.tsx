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
import { countIdeas, Switch } from './parts';
import { displayTitle } from '../../lib/displayTitle';
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
 * The setup page: Anki's deck list (pick notes, with New / Due / Mastery per row) and, beside it, a calm
 * column with what's picked, the length, two switches and Start.
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

  // What the selection holds: its ideas by how far along they are, what's due, and what can't be reviewed.
  const stats = useMemo(() => {
    const picked = [...selected].map((id) => notes[id]).filter(Boolean);
    const counts = countIdeas(picked, file);
    const blocked: { id: string; label: string }[] = [];
    const groups = new Set<string>();
    for (const n of picked) {
      const name = displayTitle(n);
      for (const s of notReviewable(n)) blocked.push({ id: n.meta.id, label: s === n.meta.title ? name : `${name} › ${s}` });
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
  // Stacked under the list (a narrow pane), Start can be out of view: a bottom bar stands in for it.
  const startRef = useRef<HTMLButtonElement>(null);
  const [startInView, setStartInView] = useState(true);
  useEffect(() => {
    const el = startRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // Half hidden counts as hidden: the bar stands in until all of Start shows.
    const io = new IntersectionObserver(([e]) => setStartInView(e.intersectionRatio > 0.99), { threshold: [0, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [tree.length]);
  // "12 new" in the stats line narrows the selection to the notes with new ideas (and so on), when that
  // would leave some notes out.
  const narrow = (bucket: 'fresh' | 'learning') => {
    const keep = [...selected].filter((id) => countIdeas([notes[id]], file)[bucket] > 0);
    if (keep.length) set(new Set(keep));
  };
  const narrowable = (bucket: 'fresh' | 'learning') => {
    const keep = [...selected].filter((id) => countIdeas([notes[id]], file)[bucket] > 0).length;
    return keep > 0 && keep < selected.size;
  };
  // Each part keeps its words together when the line wraps.
  const part = (n: number, label: string, bucket?: 'fresh' | 'learning', title?: string) =>
    n > 0 && (
      <Fragment key={label}>
        {' · '}
        {bucket && narrowable(bucket) ? (
          <button className="rv-narrow" onClick={() => narrow(bucket)} title={title}>
            {n} {label}
          </button>
        ) : (
          <span className="rv-stat">
            {n} {label}
          </span>
        )}
      </Fragment>
    );

  const helper = !selected.size
    ? 'Pick notes to start.'
    : !stats.total
      ? 'Nothing in these notes can be asked about yet.'
      : !askable
        ? `You’ve finished these notes for now. Next review ${dayLabel(stats.next)}.`
        : null;
  const label = selected.size ? selectionLabel(tree, selected) : 'Nothing picked yet';
  // The column names the classes; the note count starts the stats line under them.
  const cut = label.lastIndexOf(' · ');
  const who = selected.size && cut > 0 ? label.slice(0, cut) : label;
  const start = () => useReview.getState().start([...selected]);

  return (
    <div className="screen review-view rv-setup-page">
      <div className="screen-scroll">
        <div className={cx('rv-setup-column', !tree.length && 'is-empty')}>
          <header className="rv-head">
            <h1 className="rv-title">Review</h1>
            <span className="grow" />
            {tree.length > 0 &&
              (dueIds.length > 0 ? (
                <button className="btn is-secondary rv-due-btn" onClick={() => set(new Set(dueIds))}>
                  What’s due · {plural(dueIds.length, 'note')}
                </button>
              ) : (
                loaded && <span className="rv-due-none">Nothing due today</span>
              ))}
          </header>

          {!tree.length ? (
            <div className="rv-empty">
              <div className="rv-empty-title">Nothing to review yet</div>
              <div className="rv-empty-sub">Write a few notes first.</div>
            </div>
          ) : (
            <div className="rv-setup">
              <ReviewPicker selected={selected} onChange={set} />

              <aside className="rv-panel" aria-label="Review options">
                <div className={cx('rv-panel-label', !selected.size && 'is-none')} title={who}>
                  {who}
                </div>
                {selected.size > 0 && (
                  <div className="rv-panel-stats">
                    <span className="rv-stat">{plural(selected.size, 'note')}</span>
                    {' · '}
                    <span className="rv-stat">{plural(stats.total, 'idea')}</span>
                    {part(stats.fresh, 'new', 'fresh', 'Pick only the notes with new ideas')}
                    {part(stats.learning, 'learning', 'learning', 'Pick only the notes with ideas you’re still learning')}
                    {part(stats.mastered, 'mastered')}
                    {part(stats.due, 'due')}
                    {!askable && stats.total > 0 && (
                      <>
                        {' · '}
                        <span className="rv-stat">next review {dayLabel(stats.next)}</span>
                      </>
                    )}
                    {reading && (
                      <span className="rv-reading">
                        {' · '}
                        <span className="rv-spinner" /> finding more
                      </span>
                    )}
                  </div>
                )}

                <div className="rv-options">
                  <div className="rv-option is-stacked">
                    <span className="rv-option-label">Length</span>
                    <div className="seg rv-length" role="radiogroup" aria-label="Length">
                      {LENGTHS.map((l) => (
                        <button
                          key={l.n}
                          role="radio"
                          aria-checked={opts.length === l.n}
                          className={cx(opts.length === l.n && 'is-active')}
                          onClick={() => useReview.getState().setOpts({ length: l.n })}
                        >
                          <span>
                            {l.n} · {l.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <label
                    className={cx('rv-option rv-check', stats.groups < 2 && 'is-off')}
                    title={stats.groups < 2 ? 'Pick notes from two or more classes' : 'Questions from different classes take turns'}
                  >
                    <span className="rv-option-label">Mix classes</span>
                    <Switch checked={opts.mix && stats.groups >= 2} disabled={stats.groups < 2} onChange={(v) => useReview.getState().setOpts({ mix: v })} />
                  </label>
                  <label className="rv-option rv-check" title="Say how sure you are before you answer, to catch confident mix-ups">
                    <span className="rv-option-label">Ask how sure I am</span>
                    <Switch checked={opts.askConfidence} onChange={(v) => useReview.getState().setOpts({ askConfidence: v })} />
                  </label>
                </div>

                {stats.blocked.length > 0 && (
                  <div className="rv-warn">
                    <AlertTriangle size={16} />
                    <span>
                      Handwriting in{' '}
                      {stats.blocked.map((b, i) => (
                        <Fragment key={i}>
                          {i === 0 ? '' : i === stats.blocked.length - 1 ? ' and ' : ', '}
                          <button className="rv-warn-link" onClick={() => useUI.getState().openNote(b.id)} title="Open this note">
                            {b.label}
                          </button>
                        </Fragment>
                      ))}{' '}
                      isn’t read yet. Open the note and use “Read handwriting” to review it.
                    </span>
                  </div>
                )}

                {helper && <div className="rv-helper">{helper}</div>}
                <button ref={startRef} className="btn is-primary rv-start" disabled={!canStart} onClick={start}>
                  Start review
                </button>
                {!online && (
                  <div className="rv-promise">The local AI is offline. Questions come straight from your notes, and you check written answers yourself.</div>
                )}
              </aside>
            </div>
          )}
          {tree.length > 0 && !startInView && (
            <div className="rv-startbar">
              <span className="rv-startbar-label" title={label}>
                {label}
              </span>
              <button className="btn is-primary" disabled={!canStart} onClick={start}>
                Start review
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
