import { Fragment, useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Play, Shuffle, Target } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { conceptsOf, dueNotes, noteMastery, useReview } from '../../state/review';
import { buildReviewTree, isReviewable, selectionLabel } from '../../lib/review/tree';
import { notReviewable } from '../../lib/review/concepts';
import { isDue } from '../../lib/review/mastery';
import { dayLabel } from '../../lib/review/session';
import { ReviewPicker } from './ReviewPicker';
import { ReviewSession } from './ReviewSession';
import { ReviewSummary } from './ReviewSummary';
import { cx, plural } from '../../lib/util';

const LENGTHS: { n: number; label: string }[] = [
  { n: 10, label: '10 · Quick' },
  { n: 15, label: '15 · Standard' },
  { n: 25, label: '25 · Long' },
];

/** What the start button says when everything picked is learned and not due yet. */
function nothingDue(next: number | null): string {
  const day = dayLabel(next);
  return day === 'today' ? 'Nothing due until later today' : `Nothing due until ${day}`;
}

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

  // What the selection holds: ideas, how many are due, how many are new, and when the next one is due.
  const stats = useMemo(() => {
    const now = Date.now();
    let ideas = 0;
    let due = 0;
    let fresh = 0;
    let next: number | null = null;
    const blocked: { id: string; label: string }[] = [];
    const groups = new Set<string>();
    for (const id of selected) {
      const n = notes[id];
      if (!n) continue;
      const cs = conceptsOf(n, file);
      ideas += cs.length;
      for (const c of cs) {
        const st = file.states[c.id];
        if (!st?.attempts) fresh++;
        else if (isDue(st, now)) due++;
        else next = Math.min(next ?? st.due, st.due);
      }
      for (const s of notReviewable(n)) blocked.push({ id, label: s === n.meta.title ? s : `${n.meta.title} › ${s}` });
      groups.add(tree.find((g) => g.chapters.some((ch) => ch.notes.some((x) => x.meta.id === id)))?.key ?? '');
    }
    return { ideas, due, fresh, next, blocked, groups: groups.size };
  }, [selected, notes, file, tree]);
  // A session asks what's due or new; with neither there's nothing to start.
  const askable = stats.due + stats.fresh > 0;

  // "What's due": every note with an idea due now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dueIds = useMemo(() => (loaded ? dueNotes().ids : []), [notes, file, loaded]);

  const set = (ids: Set<string>) => useReview.getState().setSelection([...ids]);
  const mastery = (id: string) => (notes[id] ? noteMastery(notes[id]) : null);

  return (
    <div className="collection review-view">
      <div className="collection-head">
        <div className="collection-title">
          <span className="collection-icon is-review">
            <Target size={20} />
          </span>
          <div>
            <h1>Review</h1>
            <div className="collection-sub">Pick any notes — mix classes if you like. Every question and answer comes only from these notes.</div>
          </div>
        </div>
        {dueIds.length > 0 && (
          <div className="collection-actions">
            <button className="btn is-ghost" onClick={() => set(new Set(dueIds))}>
              What’s due ({dueIds.length === 1 ? '1 note' : `${dueIds.length} notes`})
            </button>
          </div>
        )}
      </div>

      <div className="rv-setup">
        <ReviewPicker selected={selected} onChange={set} mastery={mastery} />
        <aside className="rv-panel">
          <div className="rv-panel-label">{selected.size ? selectionLabel(tree, selected) : 'Nothing picked yet'}</div>
          {selected.size > 0 && (
            <div className="rv-panel-stats">
              {plural(stats.ideas, 'idea')} · {askable || !stats.ideas ? `${stats.due} due · ${stats.fresh} new` : `nothing due — next review ${dayLabel(stats.next)}`}
              {reading && <span className="rv-reading"> · finding more…</span>}
            </div>
          )}
          <div className="rv-field">
            <span className="rv-field-label">Length</span>
            <div className="seg">
              {LENGTHS.map((l) => (
                <button key={l.n} className={cx(opts.length === l.n && 'is-active')} onClick={() => useReview.getState().setOpts({ length: l.n })}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <label className={cx('rv-check', stats.groups < 2 && 'is-off')} title="Mixing topics feels harder but sticks better.">
            <input type="checkbox" checked={opts.mix} disabled={stats.groups < 2} onChange={(e) => useReview.getState().setOpts({ mix: e.target.checked })} />
            <Shuffle size={14} /> Mix classes
          </label>
          <label className="rv-check" title="Saying how sure you are helps catch the mix-ups you don’t know you have.">
            <input type="checkbox" checked={opts.askConfidence} onChange={(e) => useReview.getState().setOpts({ askConfidence: e.target.checked })} />
            Ask how sure I am
          </label>
          {stats.blocked.length > 0 && (
            <div className="rv-warn">
              <AlertTriangle size={14} />
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
          <button className="btn is-primary rv-start" disabled={!selected.size || !stats.ideas || !askable || !loaded} onClick={() => useReview.getState().start([...selected])}>
            {selected.size > 0 && stats.ideas > 0 && !askable ? (
              nothingDue(stats.next)
            ) : (
              <>
                <Play size={15} /> Start review
              </>
            )}
          </button>
          <div className="rv-promise">
            Questions are built from your notes’ own words, and answers are checked against them.
            {!online && ' Your local model is offline — you’ll get questions built straight from your notes.'}
          </div>
        </aside>
      </div>
    </div>
  );
}
