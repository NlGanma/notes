import { useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ClipboardList, Link2, Plus, ScanText, MessageCircleQuestion, TriangleAlert, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI, visionModel } from '../../state/ai';
import { classForFolder, classInfo, inFolder } from '../../lib/classes';
import { dueLabel, homeworkSources, suggestSources } from '../../lib/homework';
import { linkNotes, toggleAssistant } from '../../lib/commands';
import { needsReading, readScannedPages } from '../../lib/scan';
import { ClassBadge } from '../../components/classes/ClassIcon';
import { toast } from '../../components/common/toast';
import { cx, plural } from '../../lib/util';

function toDateInput(t?: number) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The strip under a homework's title: due date, done, and the notes its
 * answers may come from (with one-click suggestions when none are linked).
 */
export function HomeworkBar({ note }: { note: NoteDoc }) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const hw = note.meta.homework!;
  const [reading, setReading] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  const sources = useMemo(() => homeworkSources(note, notes), [note, notes]);
  const classPath = classForFolder(note.meta.folder, folderMeta);
  const cls = classPath ? classInfo(classPath, folderMeta[classPath]) : null;
  const suggestions = useMemo(() => (sources.length ? [] : suggestSources(note, notes, 2, classPath)), [sources.length, note, notes, classPath]);
  const unreadPages = useMemo(() => (note.content.content ?? []).filter((b) => b.type === 'image' && needsReading(b.attrs)).length, [note.content]);
  const due = dueLabel(hw.due);
  const update = (patch: Partial<typeof hw>) => useVault.getState().updateMeta(note.meta.id, { homework: { ...hw, ...patch } });

  // Linked folders show as one chip ("All Calculus I notes"); single notes as their own chips.
  const folderChips = hw.folders.map((f) => ({
    key: `f:${f}`,
    label: folderMeta[f]?.kind === 'class' ? `All ${classInfo(f, folderMeta[f]).name} notes` : `All of ${f.split('/').pop()}`,
    count: sources.filter((n) => inFolder(n, f)).length,
    remove: () => update({ folders: hw.folders.filter((x) => x !== f) }),
  }));
  const noteChips = hw.sources
    .map((id) => notes[id])
    .filter((n): n is NoteDoc => !!n && !n.meta.trashed && !hw.folders.some((f) => inFolder(n, f)))
    .map((n) => ({ key: n.meta.id, note: n }));

  const readPages = async () => {
    if (!visionModel(useAI.getState())) {
      toast.error('No vision model', 'Reading scanned pages needs a model that can see images (e.g. qwen2.5vl). Set one in Settings → Local AI.');
      return;
    }
    setReading(true);
    try {
      const n = await readScannedPages(note.meta.id);
      toast.success('Pages read', `${plural(n, 'page')} — the assistant can now see the questions`);
    } catch (e) {
      toast.error('Couldn’t read the pages', String((e as Error).message ?? e));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="hw-bar" style={cls ? { ['--class' as string]: cls.color } : undefined}>
      <div className="hw-bar-row">
        <span className="hw-badge">
          <ClipboardList size={13} /> Homework
        </span>
        {cls && (
          <button className="hw-class" onClick={() => useUI.getState().setView({ kind: 'class', path: cls.path })}>
            <ClassBadge cls={cls} size={16} />
            {cls.name}
          </button>
        )}
        <button
          className={cx('due-pill is-button', due ? `is-${due.tone}` : 'is-unset')}
          onClick={() => {
            const el = dateRef.current;
            if (!el) return;
            try {
              el.showPicker();
            } catch {
              el.focus();
            }
          }}
        >
          <CalendarDays size={12} />
          {hw.done ? 'Done' : (due?.text ?? 'Set due date')}
          <input
            ref={dateRef}
            className="hw-date-input"
            type="date"
            value={toDateInput(hw.due)}
            onChange={(e) => {
              const [y, m, d] = e.target.value.split('-').map(Number);
              update({ due: e.target.value ? new Date(y, m - 1, d, 23, 59).getTime() : undefined });
            }}
            tabIndex={-1}
            aria-label="Due date"
          />
        </button>
        <button className={cx('hw-done', hw.done && 'is-on')} onClick={() => update({ done: !hw.done })}>
          <span className="hw-check-mini">{hw.done && <Check size={10} strokeWidth={3} />}</span>
          {hw.done ? 'Done' : 'Mark done'}
        </button>
        <span className="grow" />
        {unreadPages > 0 && (
          <button className="hw-read" onClick={() => void readPages()} disabled={reading} title="Read the scanned pages so the assistant can see the questions">
            {reading ? <span className="spinner" /> : <ScanText size={13} />} {reading ? 'Reading…' : `Read ${plural(unreadPages, 'page')}`}
          </button>
        )}
        <button className="btn is-ai is-small" onClick={() => toggleAssistant(true)}>
          <MessageCircleQuestion size={13} /> Help with this
        </button>
      </div>
      <div className="hw-bar-row is-sources">
        <span className="hw-sources-label">
          <Link2 size={12} /> Answers only from
        </span>
        {folderChips.map((c) => (
          <span key={c.key} className="hw-source-chip is-folder">
            {c.label}
            <span className="hw-source-count">{c.count}</span>
            <button onClick={c.remove} aria-label="Unlink">
              <X size={11} />
            </button>
          </span>
        ))}
        {noteChips.map(({ key, note: n }) => (
          <span key={key} className="hw-source-chip">
            <button className="hw-source-open" onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}>
              {n.meta.title || 'Untitled'}
            </button>
            <button onClick={() => update({ sources: hw.sources.filter((x) => x !== n.meta.id) })} aria-label="Unlink">
              <X size={11} />
            </button>
          </span>
        ))}
        {!sources.length && (
          <span className="hw-no-sources">
            <TriangleAlert size={12} /> No notes linked — answers would be general knowledge
          </span>
        )}
        {suggestions.map((s) => (
          <button
            key={s.note.meta.id}
            className="hw-suggest"
            onClick={() => update({ sources: [...hw.sources, s.note.meta.id] })}
            title={`Matches: ${s.terms.join(', ')}`}
          >
            <Plus size={11} /> {s.note.meta.title || 'Untitled'}
          </button>
        ))}
        <button className="hw-link-btn" onClick={() => linkNotes(note.meta.id)}>
          {sources.length ? 'Edit' : 'Choose notes…'}
        </button>
      </div>
    </div>
  );
}
