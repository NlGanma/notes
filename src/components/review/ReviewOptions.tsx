import { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useReview } from '../../state/review';
import { useAI } from '../../state/ai';
import { Modal } from '../common/Modal';
import { Key, Switch } from './parts';
import { cx } from '../../lib/util';

const SHORTCUTS: [keys: string[], what: string][] = [
  [['1', '2', '3', '4'], 'Choose an answer'],
  [['1', '2', '3'], 'Say how a self-check went'],
  [['Enter'], 'Answer, or continue'],
  [['Esc'], 'Leave the answer box, then end the session'],
];

/**
 * Quizlet's study-mode Options dialog: described rows with a switch at the right, "Keyboard shortcuts · View",
 * then the destructive action as a red link at the bottom.
 */
export function ReviewOptions({ open, onClose, classes }: { open: boolean; onClose(): void; classes: number }) {
  const opts = useReview((s) => s.opts);
  const sure = useReview((s) => s.session?.opts.askConfidence ?? s.opts.askConfidence);
  const online = useAI((s) => s.status === 'online');
  const [keys, setKeys] = useState(false);

  // Asking how sure is only about what the screen shows, so it applies from this question on.
  const setSure = (v: boolean) =>
    useReview.setState((s) => ({
      opts: { ...s.opts, askConfidence: v },
      session: s.session ? { ...s.session, opts: { ...s.session.opts, askConfidence: v } } : s.session,
    }));

  return (
    <Modal open={open} onClose={onClose} title="Options" width={560} className="rv-options-dialog">
      <div className="rv-opt-list">
        <label className="rv-opt-row">
          <span className="rv-option-text">
            <span className="rv-option-label">Ask how sure I am</span>
            <span className="rv-option-desc">Say how sure you are before you answer. Confident mix-ups are the easiest to fix.</span>
          </span>
          <Switch checked={sure} onChange={setSure} label="Ask how sure I am" />
        </label>
        <label className={cx('rv-opt-row', classes < 2 && 'is-off')}>
          <span className="rv-option-text">
            <span className="rv-option-label">Mix classes</span>
            <span className="rv-option-desc">{classes < 2 ? 'Pick notes from two or more classes to mix them.' : 'Questions from different classes take turns. Takes effect next session.'}</span>
          </span>
          <Switch checked={opts.mix && classes >= 2} disabled={classes < 2} onChange={(v) => useReview.getState().setOpts({ mix: v })} label="Mix classes" />
        </label>
        <div className="rv-opt-row">
          <span className="rv-option-text">
            <span className="rv-option-label">Keyboard shortcuts</span>
          </span>
          <button className="btn is-ghost rv-view-keys" aria-expanded={keys} onClick={() => setKeys(!keys)}>
            View <ChevronDown size={18} className={cx('rv-chev-down', keys && 'is-open')} />
          </button>
        </div>
        {keys && (
          <div className="rv-keys">
            {SHORTCUTS.map(([k, what]) => (
              <div key={what} className="rv-keys-row">
                <span className="rv-keys-keys">
                  {k.map((x) => (
                    <Key key={x}>{x}</Key>
                  ))}
                </span>
                <span>{what}</span>
              </div>
            ))}
          </div>
        )}
        <div className="rv-opt-row is-info">
          <ShieldCheck size={20} />
          <span>
            Questions and answers come only from your notes.
            {!online && ' Your local model is offline — questions are built straight from your notes, and you check free answers yourself.'}
          </span>
        </div>
        <div className="rv-opt-row is-end">
          <button
            className="btn is-danger-text rv-end"
            onClick={() => {
              onClose();
              useReview.getState().end();
            }}
          >
            End session
          </button>
        </div>
      </div>
    </Modal>
  );
}
