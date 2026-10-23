import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { BookOpen, Check, ExternalLink, Lightbulb, X } from 'lucide-react';
import { canOverride, factOf, questionNumber, useReview, type Current } from '../../state/review';
import { sectionShown } from '../../lib/review/items';
import { useUI } from '../../state/ui';
import { useAssistant } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { renderMarkdown } from '../../lib/ai/markdown';
import { displayTitle } from '../../lib/displayTitle';
import type { Confidence } from '../../lib/review/mastery';
import { cx } from '../../lib/util';
import { toast } from '../common/toast';
import { SELF_GRADES, sessionKey } from './sessionKeys';
import { Key } from './parts';

/** Enter that ends a line, not one that picks a candidate in an input method (Chinese, Japanese, Korean…). */
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

const GRADES = ['Missed it', 'Partly', 'Got it'];

const md = (s: string) => renderMarkdown(s);

/** Short prompts read large, long ones smaller. */
const promptSize = (s: string) => (s.length <= 80 ? 'is-l' : s.length <= 200 ? 'is-m' : 'is-s');

/** The name a source goes by: the note's display name when it's still there. */
function useSourceName(src: { noteId: string; title: string }) {
  const note = useVault((s) => s.notes[src.noteId]);
  return note ? displayTitle(note) : src.title;
}

/**
 * One question at a time on a quiet white card, with a thin progress line along the top bar. The answer
 * is marked in place and the notes' own words follow it on the card.
 */
export function ReviewSession() {
  const session = useReview((s) => s.session)!;
  const current = useReview((s) => s.current);
  const pool = useReview((s) => s.pool);
  const pastSessions = useReview((s) => s.file.sessions.length);
  const meta = current ? pool.find((p) => p.id === current.concept.id) : undefined;
  const groups = useMemo(() => [...new Set(pool.map((p) => p.groupName))], [pool]);
  const stage = useRef<HTMLDivElement>(null);
  const sourceName = useSourceName(current?.item.source ?? { noteId: '', title: '' });

  // Esc leaves the answer box, then ends the session; Enter moves on from feedback; 1–4 pick a choice and 1–3 grade
  // a self-check, when the key is meant for the session.
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

  // Each question starts at the top.
  useLayoutEffect(() => {
    stage.current?.scrollTo({ top: 0 });
  }, [current?.shownAt]);

  if (!current) return null;
  const section = sectionShown(current.item, factOf(current.item, current.concept)?.key);
  const ask = current.phase === 'ask' || current.phase === 'grading';
  const feedback = current.phase === 'feedback';
  const retrying = feedback && canRetryOf(current);
  // The keys, for the first questions of the first sessions; then the hint keeps out of the way.
  const tip = pastSessions < 3 && session.index < 3 && (ask || current.phase === 'self');
  const total = session.opts.length;
  const done = Math.min(session.index, total);
  const right = session.history.filter((h) => h.s >= 0.8).length;
  const label = groups.join(' + ');
  const where = `${meta?.groupName ? `${meta.groupName} · ` : ''}${sourceName}${section ? ` › ${section}` : ''}`;

  return (
    <div className="screen review-view rv-session">
      <div className="rv-topbar">
        <div className="rv-topbar-inner">
          <div className="rv-topbar-label" title={label}>
            {label}
          </div>
          <span className="rv-count" aria-hidden>
            {questionNumber(session, current)} / {total}
          </span>
          <button className="icon-btn rv-close" onClick={() => useReview.getState().end()} title="End the session (Esc)" aria-label="End the session">
            <X size={18} />
          </button>
        </div>
        <div
          className="rv-progress"
          role="progressbar"
          aria-label="Questions answered"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          title={`${done} of ${total} answered · ${right} right`}
        >
          <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
        </div>
      </div>

      <div className="rv-stage" ref={stage}>
        <div className="rv-column">
          {/* A card per question, so its entrance plays each time. */}
          <div
            key={current.shownAt}
            className={cx('rv-card', `is-${current.phase}`)}
            data-concept={current.concept.id}
            data-item-key={current.item.key}
            data-class={meta?.group}
            data-source={current.item.origin}
            data-format={current.item.format}
          >
            <div className="rv-card-head">
              {meta?.color && <span className="class-square" style={{ background: meta.color }} aria-hidden />}
              <span
                className="rv-where"
                title={`${where}\n${current.item.origin === 'model' ? 'Phrased by your local model, checked against your notes' : 'Built from your notes'}`}
              >
                {where}
              </span>
              {ask && !current.hintUsed && current.item.format !== 'mcq' && (
                <button
                  className="btn is-ghost is-small rv-hint-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    useReview.getState().showHint();
                    // The button goes once used: typing goes on in the answer box.
                    document.querySelector<HTMLElement>('.rv-card .rv-input')?.focus();
                  }}
                  disabled={current.phase === 'grading'}
                >
                  <Lightbulb size={16} /> Hint
                </button>
              )}
            </div>
            <div className={cx('md rv-prompt', promptSize(current.item.prompt))} dangerouslySetInnerHTML={{ __html: md(current.item.prompt) }} />
            {ask && current.hint && <Hint text={current.hint} />}
            {ask && <Ask current={current} askConfidence={session.opts.askConfidence} />}
            {current.phase === 'self' && <SelfGrade current={current} />}
            {feedback && <Answered current={current} />}
            {feedback && <Feedback current={current} />}
            {retrying ? <RetryBox key={current.shownAt} current={current} /> : feedback && <FeedbackFoot current={current} />}
          </div>
          {tip && <Shortcut current={current} />}
        </div>
      </div>
    </div>
  );
}

/** The keys for this question, as one quiet line under the card. */
function Shortcut({ current }: { current: Current }) {
  const item = current.item;
  const n = item.choices?.length ?? 4;
  return (
    <div className="rv-tip">
      {current.phase === 'self' ? (
        <>
          <Key>1</Key> <Key>2</Key> <Key>3</Key> say how it went
        </>
      ) : item.format === 'mcq' ? (
        <>
          <Key>1</Key>–<Key>{n}</Key> choose
        </>
      ) : item.format === 'rate' ? (
        <>
          <Key>Enter</Key> shows your notes
        </>
      ) : (
        <>
          <Key>Enter</Key> answers
        </>
      )}
      <span className="rv-tip-sep">·</span>
      <Key>Esc</Key> ends the session
    </div>
  );
}

/** Multiple-choice tiles, numbered for the keys. After the answer they show how it went. */
function Choices({ current, onChoose, disabled }: { current: Current; onChoose?(i: number): void; disabled?: boolean }) {
  const item = current.item;
  const choices = item.choices ?? [];
  const done = current.phase === 'feedback';
  // Long options or display maths read better one per row.
  const single = choices.some((c) => c.length > 60 || c.includes('$$'));
  return (
    <div className={cx('rv-choices', single && 'is-single', done && 'is-done')}>
      {choices.map((c, i) => {
        const chosen = done && current.choice === i;
        const correct = done && i === item.correct;
        const state = chosen ? (correct ? 'is-right' : 'is-wrong') : correct ? 'is-answer' : done ? 'is-dim' : undefined;
        return (
          <button key={i} className={cx('rv-choice', state)} onClick={() => onChoose?.(i)} disabled={disabled || done}>
            <span className="rv-choice-n">{correct ? <Check size={14} strokeWidth={2.5} /> : chosen ? <X size={14} strokeWidth={2.5} /> : i + 1}</span>
            <span className="md" dangerouslySetInnerHTML={{ __html: md(c) }} />
          </button>
        );
      })}
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
  const idk = (
    <button className="btn is-ghost rv-idk" onClick={() => useReview.getState().dontKnow()} disabled={grading}>
      Don’t know
    </button>
  );

  return (
    <div className="rv-ask">
      <div className="rv-answer-head">
        <span className="rv-answer-label">
          {item.format === 'mcq' ? 'Choose the answer' : item.format === 'rate' ? 'Answer in your head or on paper, then check your notes' : 'Your answer'}
        </span>
        {/* Clicking a segment keeps the answer box focused, so Enter still checks and typing goes on. */}
        {askConfidence && (
          <div className="seg rv-conf" role="radiogroup" aria-label="How sure are you?">
            {CONF.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={conf === c.id}
                className={cx(conf === c.id && 'is-active')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => useReview.getState().setConf(conf === c.id ? null : c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {item.format === 'mcq' ? (
        <>
          <Choices current={current} onChoose={(i) => useReview.getState().choose(i, conf)} disabled={grading} />
          <div className="rv-ask-actions">{idk}</div>
        </>
      ) : (
        <>
          {item.format !== 'rate' &&
            (long ? (
              <textarea
                ref={ref}
                className="rv-input is-long"
                rows={3}
                placeholder="Type the answer in your own words"
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
                placeholder="Type the answer"
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
            ))}
          <div className="rv-ask-actions">
            {grading && (
              <span className="rv-grading">
                <span className="rv-spinner" /> Checking against your notes…
              </span>
            )}
            <span className="grow" />
            {idk}
            <button className="btn is-primary rv-check-btn" onClick={submit} disabled={grading || (item.format !== 'rate' && !text.trim())}>
              {item.format === 'rate' ? 'Show my notes' : 'Answer'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** After the answer, the card keeps it in place: the tiles marked, or the written answer in the verdict's tone. */
function Answered({ current }: { current: Current }) {
  const fb = current.feedback!;
  const item = current.item;
  if (item.format === 'mcq')
    return (
      <div className="rv-ask">
        <div className="rv-answer-head">
          <span className="rv-answer-label">{current.dontKnow ? 'The answer' : 'Your answer'}</span>
        </div>
        <Choices current={current} />
      </div>
    );
  if (item.format === 'rate') {
    const chosen = SELF_GRADES.indexOf(fb.s);
    return (
      <div className="rv-self-result">
        <div className="rv-answer-head">
          <span className="rv-answer-label">How you did</span>
        </div>
        <div className="rv-grades is-done">
          {GRADES.map((label, i) => (
            <button key={label} className={cx('rv-grade', i === chosen ? `is-chosen is-${fb.verdict}` : 'is-dim')} disabled>
              <span className="rv-choice-n">{i + 1}</span> {label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const retry = current.retry;
  const shown = retry ? retry.answer : current.answer;
  if (current.dontKnow || !shown?.trim()) return null;
  const tone = retry ? (retry.checking || retry.s === undefined ? 'is-plain' : retry.s >= 0.8 ? 'is-right' : 'is-wrong') : `is-${fb.verdict}`;
  return (
    <div className="rv-ask">
      <div className="rv-answer-head">
        <span className="rv-answer-label">{retry ? 'Your second try' : 'Your answer'}</span>
      </div>
      <div className={cx('rv-answered', tone)}>{shown}</div>
    </div>
  );
}

const canRetryOf = (cur: Current) =>
  cur.feedback!.verdict !== 'right' && !cur.dontKnow && !cur.revealed && !cur.retry && cur.item.format !== 'mcq' && cur.item.format !== 'rate';

/** A miss on a written answer: the box opens again for one more try (Enter on an empty box moves on). */
function RetryBox({ current }: { current: Current }) {
  const [again, setAgain] = useState('');
  const send = () => void useReview.getState().retry(again);
  return (
    <>
      <div className="rv-ask rv-retry">
        <input
          className="rv-input"
          placeholder="Try once more"
          value={again}
          autoFocus
          onChange={(e) => setAgain(e.target.value)}
          onKeyDown={(e) => {
            if (leaveOnEsc(e) || !isEnter(e)) return;
            e.preventDefault();
            if (again.trim()) send();
            else useReview.getState().next();
          }}
        />
      </div>
      <FeedbackFoot current={current}>
        <button className="btn is-primary rv-check-btn" disabled={!again.trim()} onClick={send}>
          Answer
        </button>
      </FeedbackFoot>
    </>
  );
}

/** The idea's mastery: shown where it was, then moved to where it is now (so the change is seen). */
function MasteryBar({ before, after }: { before: number; after: number }) {
  const [width, setWidth] = useState(before);
  useEffect(() => {
    const id = window.setTimeout(() => setWidth(after), 200);
    return () => window.clearTimeout(id);
  }, [after]);
  return (
    <span className="rv-bar">
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

/** A hint quotes the notes, math and all. */
function Hint({ text }: { text: string }) {
  return (
    <div className="rv-hint">
      <Lightbulb size={16} />
      <span className="md is-inline" dangerouslySetInnerHTML={{ __html: md(text).trim() }} />
    </div>
  );
}

/**
 * The notes' own words, with the part of the note they come from (it opens there): the line, or `points`
 * in its place, and then any `extra` points the same part of the note makes.
 */
function NotesSay({ current, label = 'Your notes say', points, extra }: { current: Current; label?: string; points?: string[]; extra?: string[] }) {
  const src = current.item.source;
  const name = useSourceName(src);
  return (
    <div className="rv-notes-say">
      <div className="rv-notes-say-head">
        <span>{label}</span>
        <button
          className="rv-source-chip"
          onClick={() => useUI.getState().openNote(src.noteId, { blockId: src.blockId ?? undefined })}
          title="Open this part of your notes"
        >
          <span>
            {name}
            {src.section ? ` › ${src.section}` : ''}
          </span>
          <ExternalLink size={12} />
        </button>
      </div>
      {points?.length ? (
        <ul className="rv-points">
          {points.map((p, i) => (
            <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
          ))}
        </ul>
      ) : (
        <div className="md rv-notes-say-text" dangerouslySetInnerHTML={{ __html: md(current.item.fact) }} />
      )}
      {!points?.length && extra?.length ? (
        <ul className="rv-points">
          {extra.map((p, i) => (
            <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A line without its markdown, for comparing. */
const plain = (s: string) =>
  s
    .replace(/\*\*|==|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A self-check: the notes' answer, then three grades (Anki's buttons), numbered for the keys. */
function SelfGrade({ current }: { current: Current }) {
  // The points besides the line "Your notes say" already shows.
  const points = (current.item.points ?? []).filter((p) => plain(p) !== plain(current.item.fact));
  return (
    <div className="rv-self">
      {current.answer?.trim() && (
        <div className="rv-ask">
          <div className="rv-answer-head">
            <span className="rv-answer-label">Your answer</span>
          </div>
          <div className="rv-answered is-plain">{current.answer}</div>
        </div>
      )}
      <NotesSay current={current} extra={points} />
      <div className="rv-answer-head">
        <span className="rv-answer-label">How did you do?</span>
      </div>
      <div className="rv-grades">
        {GRADES.map((label, i) => (
          <button key={label} className="rv-grade" onClick={() => useReview.getState().selfGrade(SELF_GRADES[i])}>
            <span className="rv-choice-n">{i + 1}</span> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * How the answer went, inline on the card: the verdict in a soft tone (green when right, red when not,
 * neutral for "partly" and "don't know"), then the notes' own words and the idea's mastery change.
 */
function Feedback({ current }: { current: Current }) {
  const fb = current.feedback!;
  const missedBefore = useReview((s) => (s.current ? (s.current.sessBefore?.misses[s.current.concept.id] ?? 0) : 0));
  // The idea as the summary will name it (an untitled note's own text goes by the note's name).
  const ideaName = useReview((s) => s.pool.find((p) => p.id === current.concept.id)?.name) ?? current.concept.name.replace(/\*\*/g, '');
  // "I don't know" is no mistake: the answer, in a neutral tone rather than red.
  const idk = !!current.dontKnow;
  const canRetry = canRetryOf(current);
  const retry = current.retry;
  // A second try that landed turns the red down: the first answer still counts, but the news is good.
  const tone = current.overridden ? 'right' : idk || fb.verdict === 'partial' || (retry?.s !== undefined && retry.s >= 0.8) ? 'neutral' : fb.verdict;
  const title = idk
    ? 'Here’s the answer'
    : current.overridden
      ? 'Counted as right'
      : fb.verdict === 'right'
        ? missedBefore > 0
          ? 'Right this time'
          : 'Right'
        : fb.verdict === 'partial'
          ? 'Partly right'
          : 'Not quite';
  const adds = fb.verdict === 'partial' ? (fb.missed ?? []) : [];

  return (
    <section className={cx('rv-feedback', `is-${tone}`)} aria-live="polite">
      <div className="rv-feedback-head">
        <span className="rv-feedback-icon" aria-hidden>
          {idk || fb.verdict === 'partial' ? (
            <BookOpen size={14} />
          ) : fb.verdict === 'right' || current.overridden ? (
            <Check size={14} strokeWidth={2.75} />
          ) : (
            <X size={14} strokeWidth={2.75} />
          )}
        </span>
        <div className={cx('rv-verdict', `is-${fb.verdict}`, idk && 'is-idk')}>{title}</div>
        {fb.note && <div className="rv-grade-note">{fb.note}</div>}
      </div>
      {fb.hypercorrect && <div className="rv-hyper">You were sure about this one. Confident mix-ups are the easiest to fix now.</div>}
      {fb.lucky && <div className="rv-hyper">Right, though you were guessing.</div>}

      {canRetry && (
        <div className="rv-retry-note">
          {current.hint && <Hint text={current.hint} />}
          <div>
            Try once more, or{' '}
            <button className="rv-link rv-show" onClick={() => useReview.getState().reveal()}>
              show the answer
            </button>
          </div>
        </div>
      )}
      {/* Once counted as right, the second try's verdict is beside the point. */}
      {current.overridden ? null : retry?.checking ? (
        <div className="rv-grading">
          <span className="rv-spinner" /> Checking against your notes…
        </div>
      ) : retry && retry.s === undefined ? (
        <div className="rv-retry-result">Compare it with what your notes say.</div>
      ) : retry && retry.s !== undefined ? (
        <div className={cx('rv-retry-result', retry.s >= 0.8 ? 'is-right' : 'is-wrong')}>
          {retry.s >= 0.8 ? 'Got it on the second try.' : 'Not yet. Here’s what your notes say.'}
        </div>
      ) : null}

      {(current.revealed || (!canRetry && !retry?.checking)) && (
        <NotesSay current={current} label={adds.length ? 'What your notes add' : 'Your notes say'} points={adds} />
      )}

      <div className="rv-mastery-change" title="How well you know this idea">
        <span className="rv-mastery-name" title={ideaName}>
          {ideaName}
        </span>
        <MasteryBar before={fb.before} after={fb.after} />
        <span className="rv-pct">
          {fb.before}% → {fb.after}%
        </span>
        {fb.mastered && <span className="rv-badge">Mastered</span>}
      </div>
    </section>
  );
}

/** Under the feedback: Explain, "I was right" and Report at the left, Continue (and a retry's Answer) at the right. */
function FeedbackFoot({ current, children }: { current: Current; children?: ReactNode }) {
  const fb = current.feedback!;
  const overrides = useReview((s) => s.overrides);
  const ref = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const wrong = fb.verdict !== 'right';
  const canRetry = canRetryOf(current);
  const retry = current.retry;

  // Continue takes the focus (Enter moves on), unless the answer box is open for another try; either way the
  // end of the card comes into view.
  useEffect(() => {
    if (!canRetry) next.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [canRetry, retry?.checking]);

  const report = () => {
    const key = current.item.key;
    useReview.getState().report();
    toast.info('Question reported. You won’t see it again.', undefined, { label: 'Undo', run: () => useReview.getState().unreport(key) });
  };
  const explain = () => {
    const src = current.item.source;
    const note = useVault.getState().notes[src.noteId];
    useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'note', id: src.noteId } });
    void useAssistant.getState().askLibrary({
      prompt: `Why is this so: ${current.item.fact.replace(/\*\*|==/g, '')}`,
      scope: { kind: 'note', id: src.noteId },
      scopeLabel: note ? displayTitle(note) : undefined,
    });
  };

  return (
    <div className="rv-card-foot" ref={ref}>
      <div className="rv-links">
        <button className="btn is-ghost is-small rv-link-btn" onClick={explain} title="Ask your notes why, answered only from your notes">
          Explain this answer
        </button>
        {/* Counted, the button keeps its place, so Report doesn't slide under the pointer. */}
        {current.overridden ? (
          <button className="btn is-ghost is-small rv-link-btn" disabled>
            <Check size={14} /> Counted
          </button>
        ) : (
          wrong &&
          canOverride(current) &&
          overrides < 3 && (
            <button
              className="btn is-ghost is-small rv-link-btn"
              onClick={() => useReview.getState().override()}
              title="Count it as right (at most 3 times a session)"
            >
              I was right
            </button>
          )
        )}
        <button className="btn is-ghost is-small rv-link-btn" onClick={report} title="This question is wrong or unclear: skip it and don’t ask it again">
          Report
        </button>
      </div>
      <span className="grow" />
      <button
        ref={next}
        className={cx('btn rv-next', canRetry ? 'is-secondary' : 'is-primary')}
        onClick={() => useReview.getState().next()}
        disabled={!!retry?.checking}
      >
        Continue
      </button>
      {children}
    </div>
  );
}
