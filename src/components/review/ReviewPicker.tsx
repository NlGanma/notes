import { useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, Folder } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useReview } from '../../state/review';
import { buildReviewTree, type ReviewGroup } from '../../lib/review/tree';
import { displayTitle } from '../../lib/displayTitle';
import { addCounts, countIdeas, GroupMark, NO_COUNTS, type IdeaCounts } from './parts';
import { cx, plural } from '../../lib/util';

type Check = 'all' | 'some' | 'none';

function checkOf(ids: string[], sel: Set<string>): Check {
  const n = ids.filter((id) => sel.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/** A checkbox that can also be half checked (some of a class or chapter picked). */
function Box({ state, label, onToggle }: { state: Check; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
      aria-label={label}
      className={cx('rv-box', `is-${state}`)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

/** New · Due · Mastery, in fixed right-aligned columns with faint zeros (Anki's deck list). */
function Counts({ c }: { c: IdeaCounts }) {
  return (
    <>
      <span className={cx('rv-num is-new', !c.fresh && 'is-zero')}>{c.fresh}</span>
      <span className={cx('rv-num is-due', !c.due && 'is-zero')}>{c.due}</span>
      <span className="rv-mastery-cell">
        {c.mastery !== null ? (
          <>
            <span className="rv-mastery" title={`${c.mastery}% mastered`}>
              <span style={{ width: `${c.mastery}%` }} />
            </span>
            <span className="rv-mastery-pct">{c.mastery}%</span>
          </>
        ) : (
          <span className="rv-mastery-none">–</span>
        )}
      </span>
    </>
  );
}

/**
 * Pick any mix of notes to review: whole classes, chapters (a class's subfolders) or single notes,
 * across as many classes as you like. Anki's deck list: a tree with New and Due counts and mastery per row.
 */
export function ReviewPicker({ selected, onChange }: { selected: Set<string>; onChange(next: Set<string>): void }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const file = useReview((s) => s.file);
  const loaded = useReview((s) => s.loaded);
  const tree = useMemo(() => buildReviewTree(notes, folders, folderMeta), [notes, folders, folderMeta]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Each note's ideas, counted once per change to the notes or what's been learned.
  const counts = useMemo(() => {
    const now = Date.now();
    const out = new Map<string, IdeaCounts>();
    if (!loaded) return out;
    for (const g of tree) for (const ch of g.chapters) for (const n of ch.notes) out.set(n.meta.id, countIdeas([n], file, now));
    return out;
  }, [tree, file, loaded]);
  const countOf = (ids: string[]) => addCounts(ids.map((id) => counts.get(id) ?? NO_COUNTS));

  // Anki's line under the deck list.
  const today = useMemo(() => {
    const start = new Date().setHours(0, 0, 0, 0);
    const done = file.sessions.filter((s) => s.at >= start);
    return { items: done.reduce((a, s) => a + s.items, 0), ms: done.reduce((a, s) => a + s.durationMs, 0) };
  }, [file.sessions]);

  const allIds = useMemo(() => tree.flatMap((g) => g.chapters.flatMap((c) => c.notes.map((n) => n.meta.id))), [tree]);

  const toggle = (ids: string[]) => {
    const next = new Set(selected);
    const all = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (all) next.delete(id);
      else next.add(id);
    }
    onChange(next);
  };

  return (
    <div className="rv-table-wrap">
      <div className="rv-tree" role="tree" aria-label="Choose notes">
        <div className="rv-tree-head">
          <span className="rv-cell-main">
            <Box state={checkOf(allIds, selected)} label="Review all notes" onToggle={() => toggle(allIds)} />
            <span>All notes</span>
          </span>
          <span className="rv-num">New</span>
          <span className="rv-num">Due</span>
          <span className="rv-mastery-cell">Mastery</span>
          <span />
        </div>
        {tree.map((g: ReviewGroup) => {
          const ids = g.chapters.flatMap((c) => c.notes.map((n) => n.meta.id));
          const isOpen = open[g.key] ?? false;
          const state = checkOf(ids, selected);
          const flip = () => setOpen({ ...open, [g.key]: !isOpen });
          return (
            <div key={g.key} className="rv-group" role="treeitem" aria-expanded={isOpen}>
              <div className={cx('rv-row is-group', state === 'all' && 'is-checked')} onClick={flip}>
                <span className="rv-cell-main">
                  <Box state={state} label={`Review all of ${g.name}`} onToggle={() => toggle(ids)} />
                  {/* The row opens on a click; the chevron is its keyboard way in. */}
                  <button
                    type="button"
                    className="rv-chev-btn"
                    aria-expanded={isOpen}
                    aria-label={`Show notes in ${g.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      flip();
                    }}
                  >
                    <ChevronRight size={16} strokeWidth={1.75} className={cx('rv-chev', isOpen && 'is-open')} />
                  </button>
                  <span className="rv-mark">
                    <GroupMark color={g.cls?.color} />
                  </span>
                  <span className="rv-name" title={g.name}>
                    {g.name}
                  </span>
                </span>
                <Counts c={countOf(ids)} />
                <span />
              </div>
              {isOpen &&
                g.chapters.map((ch) => {
                  const chIds = ch.notes.map((n) => n.meta.id);
                  const single = g.chapters.length === 1 && !ch.path;
                  const chState = checkOf(chIds, selected);
                  return (
                    <div key={ch.path || '_'} className="rv-chapter" role="group">
                      {!single && (
                        <div className={cx('rv-row is-chapter', chState === 'all' && 'is-checked')} onClick={() => toggle(chIds)}>
                          <span className="rv-cell-main">
                            <Box state={chState} label={`Review ${ch.name}`} onToggle={() => toggle(chIds)} />
                            <span className="rv-indent" />
                            <span className="rv-mark">
                              <Folder size={16} strokeWidth={1.5} className="rv-folder" />
                            </span>
                            <span className="rv-name" title={ch.name}>
                              {ch.name}
                            </span>
                            <span className="rv-sub">{plural(chIds.length, 'note')}</span>
                          </span>
                          <Counts c={countOf(chIds)} />
                          <span />
                        </div>
                      )}
                      {ch.notes.map((n) => {
                        const on = selected.has(n.meta.id);
                        const name = displayTitle(n);
                        return (
                          <div key={n.meta.id} className={cx('rv-row is-note', single && 'is-flat', on && 'is-checked')} onClick={() => toggle([n.meta.id])}>
                            <span className="rv-cell-main">
                              <Box state={on ? 'all' : 'none'} label={`Review ${name}`} onToggle={() => toggle([n.meta.id])} />
                              <span className="rv-indent" />
                              <span className={cx('rv-name', !n.meta.title && 'is-derived')} title={name}>
                                {name}
                              </span>
                            </span>
                            <Counts c={counts.get(n.meta.id) ?? NO_COUNTS} />
                            <button
                              className="icon-btn is-tiny rv-open"
                              title="Open note"
                              aria-label={`Open ${name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                useUI.getState().openNote(n.meta.id);
                              }}
                            >
                              <ExternalLink size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {today.items > 0 && (
        <div className="rv-tree-foot">
          Reviewed {plural(today.items, 'question')} today in {Math.max(1, Math.round(today.ms / 60_000))} min
        </div>
      )}
    </div>
  );
}
