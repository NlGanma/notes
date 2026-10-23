import { useMemo, useState } from 'react';
import { AlignLeft, GraduationCap, Check, FoldVertical, Heading, List, Loader2, Palette, Pilcrow, ScanText, Sigma, Text } from 'lucide-react';
import { useVault } from '../state/vault';
import { useAI, visionModel } from '../state/ai';
import { useUI } from '../state/ui';
import { useSettings, LINE_PX } from '../state/settings';
import { analyzeNote, type Suggestion } from '../lib/polish';
import { editors } from '../editor/registry';
import { toast } from './common/toast';
import { friendlyError } from '../lib/ai/errors';
import { cx } from '../lib/util';

const ICONS: Record<Suggestion['icon'], React.ReactNode> = {
  space: <FoldVertical size={16} />,
  lines: <Pilcrow size={16} />,
  list: <List size={16} />,
  colors: <Palette size={16} />,
  read: <ScanText size={16} />,
  math: <Sigma size={16} />,
  bullets: <Text size={16} />,
  summary: <AlignLeft size={16} />,
  headings: <Heading size={16} />,
  class: <GraduationCap size={16} />,
};

function useSuggestions(noteId: string) {
  const note = useVault((s) => s.notes[noteId]);
  const ai = useAI((s) => s.status === 'online' && !!s.chatModel);
  const hasVision = useAI((s) => !!visionModel(s));
  const line = LINE_PX[useSettings((s) => s.lineSpacing)];
  return useMemo(() => (note ? analyzeNote(note, { line, ai, vision: hasVision }) : []), [note, line, ai, hasVision]);
}

/** Polish, opened from the note's ⋯ menu: a short sheet of tidy-ups (edits undo with ⌘Z) and where the note belongs. */
export function PolishPanel({ noteId, onDone }: { noteId: string; onDone(): void }) {
  const suggestions = useSuggestions(noteId);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const online = useAI((s) => s.status === 'online' && !!s.chatModel);

  const apply = async (s: Suggestion) => {
    const editor = editors.get(noteId);
    const note = useVault.getState().notes[noteId];
    if (!editor || !note) return;
    setBusy(s.id);
    try {
      await s.apply(editor, note);
      setDone((d) => [...d, s.id]);
    } catch (e) {
      toast.error('Couldn’t apply that', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  // Filing the note in a class moves it on disk, so it stays a choice of its own: Apply all and ⌘Z are for edits.
  const filing = suggestions.filter((s) => s.id === 'class');
  const quick = suggestions.filter((s) => !s.ai && s.id !== 'class');
  const smart = suggestions.filter((s) => s.ai);
  const row = (s: Suggestion) => <Row key={s.id} s={s} busy={busy === s.id} done={done.includes(s.id)} onApply={() => apply(s)} />;
  const applyAll = quick.length > 1 && (
    <button
      className="btn is-ghost is-small polish-all"
      disabled={!!busy || quick.every((s) => done.includes(s.id))}
      onClick={async () => {
        for (const s of quick) if (!done.includes(s.id)) await apply(s);
        // Filing and the AI's suggestions are left for the student to choose: the sheet stays while any are.
        if ([...filing, ...smart].every((s) => done.includes(s.id))) onDone();
      }}
    >
      Apply all
    </button>
  );
  // Captions only when Apply all has to say which rows it covers; otherwise one short list.
  const grouped = !!applyAll && filing.length + smart.length > 0;

  return (
    <div className="polish">
      <div className="polish-head">
        <span className="polish-title">Polish</span>
        {!grouped && applyAll}
      </div>
      {!suggestions.length && (
        <div className="polish-empty">
          <Check size={16} />
          Nothing to tidy up.
        </div>
      )}
      {grouped ? (
        <>
          {filing.length > 0 && (
            <div className="polish-group">
              <div className="polish-group-label">Class</div>
              {filing.map(row)}
            </div>
          )}
          <div className="polish-group">
            <div className="polish-group-label">
              Quick fixes
              {applyAll}
            </div>
            {quick.map(row)}
          </div>
          {smart.length > 0 && (
            <div className="polish-group">
              <div className="polish-group-label">With the local AI</div>
              {smart.map(row)}
            </div>
          )}
        </>
      ) : (
        suggestions.length > 0 && <div className="polish-group">{[...filing, ...quick, ...smart].map(row)}</div>
      )}
      {!online && (
        <div className="polish-foot">
          More suggestions, like reading handwriting, need the local AI.
          <button className="polish-foot-link" onClick={() => (onDone(), useUI.getState().openSettings('ai'))}>
            Open settings
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ s, busy, done, onApply }: { s: Suggestion; busy: boolean; done: boolean; onApply(): void }) {
  return (
    <div className={cx('polish-row', done && 'is-done')}>
      <span className="polish-icon">{ICONS[s.icon]}</span>
      <div className="polish-text">
        <div className="polish-row-title">{s.title}</div>
        {s.detail && <div className="polish-row-detail">{s.detail}</div>}
      </div>
      <button className="btn is-secondary is-small" disabled={busy || done} onClick={onApply}>
        {busy ? <Loader2 size={16} className="spin" /> : done ? <Check size={16} /> : s.action}
      </button>
    </div>
  );
}
