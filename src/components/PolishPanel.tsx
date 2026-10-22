import { useMemo, useState } from 'react';
import {
  AlignLeft,
  CaseSensitive,
  GraduationCap,
  Check,
  FoldVertical,
  Heading,
  List,
  Loader2,
  Palette,
  Pilcrow,
  ScanText,
  Sigma,
  Tags,
  Text,
} from 'lucide-react';
import { useVault } from '../state/vault';
import { useAI, visionModel } from '../state/ai';
import { useSettings, LINE_PX } from '../state/settings';
import { analyzeNote, type Suggestion } from '../lib/polish';
import { editors } from '../editor/registry';
import { toast } from './common/toast';
import { cx } from '../lib/util';

const ICONS: Record<Suggestion['icon'], React.ReactNode> = {
  title: <CaseSensitive size={20} />,
  tags: <Tags size={20} />,
  space: <FoldVertical size={20} />,
  lines: <Pilcrow size={20} />,
  list: <List size={20} />,
  colors: <Palette size={20} />,
  read: <ScanText size={20} />,
  math: <Sigma size={20} />,
  bullets: <Text size={20} />,
  summary: <AlignLeft size={20} />,
  headings: <Heading size={20} />,
  class: <GraduationCap size={20} />,
};

function useSuggestions(noteId: string | null) {
  const note = useVault((s) => (noteId ? s.notes[noteId] : undefined));
  const ai = useAI((s) => s.status === 'online' && !!s.chatModel);
  const hasVision = useAI((s) => !!visionModel(s));
  const line = LINE_PX[useSettings((s) => s.lineSpacing)];
  return useMemo(() => (note ? analyzeNote(note, { line, ai, vision: hasVision }) : []), [note, line, ai, hasVision]);
}

/** Number of instant (non-AI) suggestions — shown as a badge on the Polish button. */
export function usePolishCount(noteId: string | null) {
  const s = useSuggestions(noteId);
  return s.filter((x) => !x.ai).length;
}

export function PolishPanel({ noteId, onDone }: { noteId: string; onDone(): void }) {
  const suggestions = useSuggestions(noteId);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const ai = useAI();

  const apply = async (s: Suggestion) => {
    const editor = editors.get(noteId);
    const note = useVault.getState().notes[noteId];
    if (!editor || !note) return;
    setBusy(s.id);
    try {
      await s.apply(editor, note);
      setDone((d) => [...d, s.id]);
    } catch (e) {
      toast.error('Couldn’t apply that', String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const quick = suggestions.filter((s) => !s.ai);
  const smart = suggestions.filter((s) => s.ai);

  return (
    <div className="polish">
      <div className="polish-head">
        <div className="polish-title">
          Polish
          {suggestions.length > 0 && <span className="polish-count">{suggestions.length - done.length}</span>}
        </div>
        <div className="polish-sub">Small changes for clean, consistent notes. Everything can be undone with ⌘Z.</div>
      </div>
      {!suggestions.length && (
        <div className="polish-empty">
          <Check size={20} />
          <div>Looking tidy. Nothing to suggest right now.</div>
        </div>
      )}
      {quick.length > 0 && (
        <div className="polish-group">
          <div className="polish-group-label">Quick fixes</div>
          {quick.map((s) => (
            <Row key={s.id} s={s} busy={busy === s.id} done={done.includes(s.id)} onApply={() => apply(s)} />
          ))}
          {quick.length > 1 && (
            <button
              className="btn is-ghost polish-all"
              disabled={!!busy}
              onClick={async () => {
                for (const s of quick) await apply(s);
                onDone();
              }}
            >
              Apply all quick fixes
            </button>
          )}
        </div>
      )}
      {smart.length > 0 && (
        <div className="polish-group">
          <div className="polish-group-label">Using your local model</div>
          {smart.map((s) => (
            <Row key={s.id} s={s} busy={busy === s.id} done={done.includes(s.id)} onApply={() => apply(s)} />
          ))}
        </div>
      )}
      {ai.status !== 'online' && (
        <div className="polish-foot">
          Connect a local model in Settings → Local AI to unlock smart suggestions (titles, tags, summaries, reading handwriting).
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
        <div className="polish-row-detail">{s.detail}</div>
      </div>
      <button className="btn is-ghost is-small" disabled={busy || done} onClick={onApply}>
        {busy ? <Loader2 size={18} className="spin" /> : done ? <Check size={18} /> : s.action}
      </button>
    </div>
  );
}
