import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, BookOpen, Check, CircleHelp, Flag, Lightbulb, MessageCircleQuestion, ShieldCheck, Undo2, X } from 'lucide-react';
import { canOverride, factOf, useReview, type Current } from '../../state/review';
import { sectionShown } from '../../lib/review/items';
import { useAI } from '../../state/ai';
import { useUI } from '../../state/ui';
import { useAssistant } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { renderMarkdown } from '../../lib/ai/markdown';
import { LEVELS, type Confidence } from '../../lib/review/mastery';
import { cx } from '../../lib/util';
import { toast } from '../common/toast';
import { SELF_GRADES, sessionKey } from './sessionKeys';

/** Enter that ends a line — not one that picks a candidate in an input method (Chinese, Japanese, Korean…). */
const isEnter = (e: ReactKeyboardEvent<HTMLElement>) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;

/** Esc in an answer box leaves the box, keeping what's typed; pressed again, it ends the session. */
const leaveOnEsc = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  if (e.key !== 'Escape' || e.nativeEvent.isComposing) return false;
  e.preventDefault();
  e.currentTarget.blur();
  return true;
};

const CONF: { id: Confidence; label: string }[] = [
  { id: 'guess', label: 'Guessing' },
  { id: 'unsure', label: 'Unsure' },
  { id: 'sure', label: 'Sure' },
];

const md = (s: string) => renderMarkdown(s);

/** One question at a time, checked against the notes, with the note's own words after every answer. */
export function ReviewSession() {
  const session = useReview((s) => s.session)!;
  const current = useReview((s) => s.current);
  const pool = useReview((s) => s.pool);
  const online = useAI((s) => s.status === 'online');
  const meta = current ? pool.find((p) => p.id === current.concept.id) : undefined;
  const groups = useMemo(() => [...new Set(pool.map((p) => p.groupName))], [pool]);

  // Esc leaves the answer box, then ends the session; Enter moves on from feedback; 1–4 pick a choice and 1–3 grade
  // a self-check — when the key is meant for the session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : document.body;
      const r = useReview.getState();
      const k = sessionKey(
        e,
        {
          inSession: t === document.body || t === document.documentElement || !!t.closest('.rv-session'),
          editable: !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
          control: !!t.closest('button, a[href], [role="button"], [role="radio"]'),
          overlay: !!document.querySelector('.modal-backdrop, .palette-backdrop, .context-menu'),
        },
        r.current,
      );
      if (!k) return;
      e.preventDefault();
      if (k.do === 'end') r.end();
      else if (k.do === 'blur') (document.activeElement as HTMLElement | null)?.blur();
      else if (k.do === 'next') r.next();
      else if (k.do === 'show') void r.submit('', r.current?.conf ?? null);
      else if (k.do === 'grade') r.selfGrade(k.s);
      else r.choose(k.index, r.current?.conf ?? null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!current) return null;
  const progress = Math.min(1, session.index / session.opts.length);
  const section = sectionShown(current.item, factOf(current.item, current.concept)?.key);

  return (
    <div className="rv-session" style={meta?.color ? { ['--class' as string]: meta.color } : undefined}>
      <div className="rv-topbar">
        <button className="btn is-ghost is-small" onClick={() => useReview.getState().end()} title="End the session (Esc)">
          End
        </button>
        <span className="rv-topbar-label">{groups.join(' + ')}</span>
        <div className="rv-progress" aria-label={`Question ${Math.min(session.index + 1, session.opts.length)} of ${session.opts.length}`}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="rv-count-label">
          {Math.min(session.index + (current.phase === 'feedback' ? 0 : 1), session.opts.length)} / {session.opts.length}
        </span>
      </div>

      <div
        className={cx('rv-card', `is-${current.phase}`)}
        data-concept={current.concept.id}
        data-item-key={current.item.key}
        data-class={meta?.group}
        data-source={current.item.origin}
        data-format={current.item.format}
      >
        <div className="rv-card-head">
          <span className="rv-class-chip">{meta?.groupName}</span>
          <span className="rv-where">
            {current.item.source.title}
            {section ? ` › ${section}` : ''}
          </span>
          <span className="grow" />
          <span className="rv-level" title={current.item.origin === 'model' ? 'AI-phrased question, checked against your notes' : 'Built from your notes'}>
            {LEVELS[current.item.level]}
          </span>
        </div>
        <div className="md rv-prompt" dangerouslySetInnerHTML={{ __html: md(current.item.prompt) }} />
        {current.phase === 'ask' || current.phase === 'grading' ? <Ask current={current} askConfidence={session.opts.askConfidence} /> : null}
        {current.phase === 'self' && <SelfGrade current={current} />}
        {current.phase === 'feedback' && <FeedbackView current={current} />}
      </div>

      <div className="rv-footnote">
        <ShieldCheck size={13} /> Questions and answers come only from your notes.
        {!online && ' Model offline — questions are built straight from your notes, and you check free answers yourself.'}
      </div>
    </div>
  );
}

function Ask({ current, askConfidence }: { current: Current; askConfidence: boolean }) {
  const [text, setText] = useState('');
  // Kept with the question, so answering a choice with the 1–4 keys keeps it too.
  const conf = current.conf ?? null;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const item = current.item;
  const grading = current.phase === 'grading';
  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [item.key, current.shownAt]);

  const submit = () => {
    if (grading) return;
    if (item.format === 'rate') {
      void useReview.getState().submit('', conf);
      return;
    }
    if (!text.trim()) return;
    void useReview.getState().submit(text, conf);
  };
  const long = item.format === 'explain' || item.format === 'apply' || item.format === 'connect';
  // Clicking a pill keeps the answer box focused, so Enter still checks and typing goes on.
  const sure = askConfidence && (
    <div className="rv-conf" role="radiogroup" aria-label="How sure are you?">
      <span className="rv-conf-label">How sure?</span>
      {CONF.map((c) => (
        <button
          key={c.id}
          role="radio"
          aria-checked={conf === c.id}
          className={cx('rv-conf-pill', conf === c.id && 'is-on')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useReview.getState().setConf(conf === c.id ? null : c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="rv-ask">
      {/* A click on a choice answers at once, so how sure comes first. */}
      {item.format === 'mcq' && sure}
      {item.format === 'mcq' ? (
        <div className="rv-choices">
          {item.choices!.map((c, i) => (
            <button key={i} className="rv-choice" onClick={() => useReview.getState().choose(i, conf)} disabled={grading}>
              <span className="rv-choice-n">{i + 1}</span>
              <span className="md" dangerouslySetInnerHTML={{ __html: md(c) }} />
            </button>
          ))}
        </div>
      ) : item.format === 'rate' ? (
        <div className="rv-rate-hint">Answer in your head (or on paper), then check it against your notes.</div>
      ) : long ? (
        <textarea
          ref={ref}
          className="rv-input is-long"
          rows={3}
          placeholder="Answer in your own words…"
          value={text}
          disabled={grading}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (leaveOnEsc(e)) return;
            if (isEnter(e) && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      ) : (
        <input
          ref={ref}
          className="rv-input"
          placeholder="Your answer…"
          value={text}
          disabled={grading}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (leaveOnEsc(e)) return;
            if (isEnter(e)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      )}
      {item.format !== 'mcq' && sure}
      {current.hint && <Hint text={current.hint} />}
      <div className="rv-actions">
        {!current.hintUsed && item.format !== 'mcq' && (
          <button
            className="btn is-ghost is-small"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              useReview.getState().showHint();
              // The button goes once used: typing goes on in the answer box.
              ref.current?.focus();
            }}
            disabled={grading}
          >
            <Lightbulb size={14} /> Hint
          </button>
        )}
        <button className="btn is-ghost is-small rv-idk" onClick={() => useReview.getState().dontKnow()} disabled={grading}>
          <CircleHelp size={14} /> I don’t know
        </button>
        <span className="grow" />
        {grading ? (
          <span className="rv-grading">
            <span className="spinner" /> Checking your answer against your notes…
          </span>
        ) : (
          item.format !== 'mcq' && (
            <button className="btn is-primary rv-check-btn" onClick={submit} disabled={item.format !== 'rate' && !text.trim()}>
              {item.format === 'rate' ? 'Show my notes' : 'Check'} <kbd>↵</kbd>
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** A hint quotes the notes, math and all. */
function Hint({ text }: { text: string }) {
  return (
    <div className="rv-hint">
      <Lightbulb size={14} />
      <span className="md is-inline" dangerouslySetInnerHTML={{ __html: md(text).trim() }} />
    </div>
  );
}

function NotesSay({ current }: { current: Current }) {
  const src = current.item.source;
  return (
    <div className="rv-notes-say">
      <div className="rv-notes-say-head">Your notes say</div>
      <div className="md rv-notes-say-text" dangerouslySetInnerHTML={{ __html: md(current.item.fact) }} />
      <button
        className="rv-source-chip"
        onClick={() => useUI.getState().openNote(src.noteId, { newTab: true, blockId: src.blockId ?? undefined })}
        title="Open this part of your notes"
      >
        {src.title}
        {src.section ? ` › ${src.section}` : ''} ↗
      </button>
    </div>
  );
}

function SelfGrade({ current }: { current: Current }) {
  return (
    <div className="rv-self">
      <NotesSay current={current} />
      {current.item.points && current.item.points.length > 1 && (
        <ul className="rv-points">
          {current.item.points.map((p, i) => (
            <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
          ))}
        </ul>
      )}
      <div className="rv-self-q">How did you do?</div>
      <div className="rv-actions">
        {['Missed it', 'Partly', 'Got it'].map((label, i) => (
          <button key={label} className={cx('btn', i === 2 ? 'is-primary' : 'is-secondary')} onClick={() => useReview.getState().selfGrade(SELF_GRADES[i])}>
            <span className="rv-choice-n">{i + 1}</span> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FeedbackView({ current }: { current: Current }) {
  const fb = current.feedback!;
  const [again, setAgain] = useState('');
  const overrides = useReview((s) => s.overrides);
  const wrong = fb.verdict !== 'right';
  // "I don't know" is no mistake: it gets the answer, not a red cross.
  const idk = !!current.dontKnow;
  const canRetry = wrong && !current.revealed && !current.retry && current.item.format !== 'mcq' && current.item.format !== 'rate';
  const retry = current.retry;
  const title = idk ? 'Here’s the answer' : fb.verdict === 'right' ? (current.overridden ? 'Counted as right' : 'Right') : fb.verdict === 'partial' ? 'Partly right' : 'Not quite';
  const report = () => {
    const key = current.item.key;
    useReview.getState().report();
    toast.info('Question reported — you won’t see it again', undefined, { label: 'Undo', run: () => useReview.getState().unreport(key) });
  };
  const ask = () => {
    const src = current.item.source;
    const note = useVault.getState().notes[src.noteId];
    useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'note', id: src.noteId } });
    void useAssistant.getState().askLibrary({
      prompt: `Why: ${current.item.fact.replace(/\*\*|==/g, '')}`,
      scope: { kind: 'note', id: src.noteId },
      scopeLabel: note?.meta.title,
    });
  };
  return (
    <div className="rv-feedback">
      <div className={cx('rv-verdict', `is-${fb.verdict}`, idk && 'is-idk')}>
        {idk ? <BookOpen size={16} /> : fb.verdict === 'right' ? <Check size={16} /> : fb.verdict === 'partial' ? <Undo2 size={16} /> : <X size={16} />}
        <b>{title}.</b>
        {current.answer && wrong && !idk && (
          <span className="rv-wrote">
            {current.item.format === 'mcq' ? (
              <>
                You picked “<span className="md is-inline" dangerouslySetInnerHTML={{ __html: md(current.answer).trim() }} />”.
              </>
            ) : (
              `You wrote “${current.answer.slice(0, 120)}”.`
            )}
          </span>
        )}
        {fb.note && <span className="rv-grade-note">{fb.note}</span>}
      </div>
      {fb.hypercorrect && <div className="rv-hyper">You were sure about this one — confident mix-ups are the easiest to fix right now.</div>}
      {fb.lucky && <div className="rv-hyper is-soft">Right — but you were guessing. Here’s the line from your notes.</div>}
      {fb.missed && fb.missed.length > 0 && fb.verdict === 'partial' && (
        <div className="rv-missed">
          <div className="rv-missed-head">What your notes add</div>
          <ul className="rv-points">
            {fb.missed.map((p, i) => (
              <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
            ))}
          </ul>
        </div>
      )}
      {canRetry && (
        <div className="rv-retry">
          {current.hint && <Hint text={current.hint} />}
          <div className="rv-retry-row">
            <input
              className="rv-input"
              placeholder="Try once more…"
              value={again}
              autoFocus
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => {
                if (leaveOnEsc(e) || !isEnter(e)) return;
                e.preventDefault();
                // An empty box: Enter moves on, as its ↵ says.
                if (again.trim()) void useReview.getState().retry(again);
                else useReview.getState().next();
              }}
            />
            <button className="btn is-secondary is-small" disabled={!again.trim()} onClick={() => void useReview.getState().retry(again)}>
              Try
            </button>
            <button className="btn is-ghost is-small rv-show" onClick={() => useReview.getState().reveal()}>
              Show the answer
            </button>
          </div>
        </div>
      )}
      {/* Once counted as right, the second try's verdict is beside the point. */}
      {current.overridden ? null : retry?.checking ? (
        <span className="rv-grading">
          <span className="spinner" /> Checking your answer against your notes…
        </span>
      ) : retry && retry.s === undefined ? (
        <div className="rv-retry-result">Compare it with what your notes say.</div>
      ) : retry && retry.s !== undefined ? (
        <div className={cx('rv-retry-result', retry.s >= 0.8 ? 'is-right' : 'is-wrong')}>{retry.s >= 0.8 ? 'Got it on the second try.' : 'Not yet — here’s what your notes say.'}</div>
      ) : null}
      {(current.revealed || (!canRetry && !retry?.checking)) && <NotesSay current={current} />}
      <div className="rv-mastery-change">
        <span className="rv-mastery-name">{current.concept.name.replace(/\*\*/g, '')}</span>
        <span className="rv-bar">
          <span style={{ width: `${fb.after}%` }} />
        </span>
        <span className="rv-pct">
          {fb.before}% → {fb.after}%
        </span>
        {fb.mastered && <span className="rv-badge">Mastered</span>}
      </div>
      <div className="rv-actions">
        <button className="btn is-ghost is-small" onClick={ask} title="Ask your notes why — answered only from your notes">
          <MessageCircleQuestion size={14} /> Why?
        </button>
        {/* Counted, the button keeps its place, so Report doesn't slide under the pointer. */}
        {current.overridden ? (
          <button className="btn is-ghost is-small" disabled>
            Counted <Check size={13} />
          </button>
        ) : (
          wrong &&
          canOverride(current) &&
          overrides < 3 && (
            <button className="btn is-ghost is-small" onClick={() => useReview.getState().override()} title="Count it as right (at most 3 times a session)">
              I was right
            </button>
          )
        )}
        <button className="btn is-ghost is-small" onClick={report} title="This question is wrong or unclear — skip it and don’t ask it again">
          <Flag size={13} /> Report question
        </button>
        <span className="grow" />
        <button className="btn is-primary rv-next" onClick={() => useReview.getState().next()}>
          Next <ArrowRight size={14} /> <kbd>↵</kbd>
        </button>
      </div>
    </div>
  );
}
