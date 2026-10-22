import { useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import { useVault } from '../../state/vault';
import { buildReviewTree, type ReviewGroup } from '../../lib/review/tree';
import { ClassBadge } from '../classes/ClassIcon';
import { cx, plural } from '../../lib/util';

type Check = 'all' | 'some' | 'none';

function checkOf(ids: string[], sel: Set<string>): Check {
  const n = ids.filter((id) => sel.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

function Box({ state, color, label, onToggle }: { state: Check; color?: string; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
      aria-label={label}
      className={cx('rv-box', `is-${state}`)}
      style={color ? { ['--class' as string]: color } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

/**
 * Pick any mix of notes to review: whole classes, chapters (a class's
 * subfolders) or single notes, across as many classes as you like.
 */
export function ReviewPicker({
  selected,
  onChange,
  mastery,
}: {
  selected: Set<string>;
  onChange(next: Set<string>): void;
  /** 0–100 per note, when the student has reviewed it before. */
  mastery?: (noteId: string) => number | null;
}) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const tree = useMemo(() => buildReviewTree(notes, folders, folderMeta), [notes, folders, folderMeta]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const toggle = (ids: string[]) => {
    const next = new Set(selected);
    const all = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (all) next.delete(id);
      else next.add(id);
    }
    onChange(next);
  };

  if (!tree.length) return <div className="rv-empty">Write some notes first — Review quizzes you on what’s in them.</div>;

  return (
    <div className="rv-tree" role="tree">
      {tree.map((g: ReviewGroup) => {
        const ids = g.chapters.flatMap((c) => c.notes.map((n) => n.meta.id));
        const isOpen = open[g.key] ?? false;
        const color = g.cls?.color;
        return (
          <div key={g.key} className="rv-group" role="treeitem" aria-expanded={isOpen}>
            <div className="rv-row is-group" onClick={() => setOpen({ ...open, [g.key]: !isOpen })}>
              <ChevronRight size={14} className={cx('rv-chev', isOpen && 'is-open')} />
              <Box state={checkOf(ids, selected)} color={color} label={`Review all of ${g.name}`} onToggle={() => toggle(ids)} />
              {g.cls ? <ClassBadge cls={g.cls} size={20} /> : <Folder size={16} className="rv-folder" />}
              <span className="rv-name">{g.name}</span>
              {g.cls?.code && <span className="rv-code">{g.cls.code}</span>}
              <span className="rv-count">{plural(ids.length, 'note')}</span>
            </div>
            {isOpen &&
              g.chapters.map((ch) => {
                const chIds = ch.notes.map((n) => n.meta.id);
                const single = g.chapters.length === 1 && !ch.path;
                return (
                  <div key={ch.path || '_'} className="rv-chapter" role="group">
                    {!single && (
                      <div className="rv-row is-chapter" onClick={() => toggle(chIds)}>
                        <Box state={checkOf(chIds, selected)} color={color} label={`Review ${ch.name}`} onToggle={() => toggle(chIds)} />
                        <span className="rv-name">{ch.name}</span>
                        <span className="rv-count">{plural(chIds.length, 'note')}</span>
                      </div>
                    )}
                    {ch.notes.map((n) => {
                      const pct = mastery?.(n.meta.id) ?? null;
                      return (
                        <div key={n.meta.id} className={cx('rv-row is-note', single && 'is-flat')} onClick={() => toggle([n.meta.id])}>
                          <Box
                            state={selected.has(n.meta.id) ? 'all' : 'none'}
                            color={color}
                            label={`Review ${n.meta.title || 'Untitled'}`}
                            onToggle={() => toggle([n.meta.id])}
                          />
                          <FileText size={14} className="rv-file" />
                          <span className="rv-name">{n.meta.title || 'Untitled'}</span>
                          {pct !== null && (
                            <span className="rv-mastery" title={`${pct}% mastered`} style={color ? { ['--class' as string]: color } : undefined}>
                              <span style={{ width: `${pct}%` }} />
                            </span>
                          )}
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
  );
}
